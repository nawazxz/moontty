// Moontty.app: a native window around the agent-deck server.
// Quitting the app stops the server and every agent; "Quit, keep agents running" (⌥⌘Q) only detaches.
import Cocoa
import WebKit

// The packaged app (mac/package.sh) carries the server and node in Resources; a dev build points at the repo.
let resources = Bundle.main.resourcePath ?? ""
let bundled = FileManager.default.fileExists(atPath: resources + "/app/server.js")
let deckDir = bundled ? resources + "/app" : Bundle.main.object(forInfoDictionaryKey: "DeckDir") as? String ?? NSHomeDirectory() + "/agent-deck"
let nodePath = bundled ? resources + "/node" : Bundle.main.object(forInfoDictionaryKey: "NodePath") as? String ?? "/usr/local/bin/node"
let port = Int(ProcessInfo.processInfo.environment["DECK_PORT"] ?? "") ?? 7681
let deckURL = URL(string: "http://localhost:\(port)")!

// Updates come from GitHub releases. Each release carries one dmg per chip; the version is the tag.
let releasesAPI = URL(string: ProcessInfo.processInfo.environment["MOONTTY_RELEASES"] ?? "https://api.github.com/repos/nawazxz/moontty/releases/latest")!
let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
#if arch(arm64)
let dmgName = "Moontty-AppleSilicon.dmg"
#else
let dmgName = "Moontty-Intel.dmg"
#endif

// "0.3.0" vs "0.2.1-4-gabc123" (a build between tags counts as its tag)
func isNewer(_ a: String, than b: String) -> Bool {
  func parts(_ v: String) -> [Int] {
    let core = v.drop(while: { $0 == "v" }).split(separator: "-").first ?? ""
    return core.split(separator: ".").map { Int($0) ?? 0 }
  }
  let x = parts(a), y = parts(b)
  for i in 0..<max(x.count, y.count) {
    let p = i < x.count ? x[i] : 0, q = i < y.count ? y[i] : 0
    if p != q { return p > q }
  }
  return false
}

@discardableResult func run(_ tool: String, _ args: [String]) -> Bool {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: tool)
  p.arguments = args
  p.standardOutput = FileHandle.nullDevice
  p.standardError = FileHandle.nullDevice
  guard (try? p.run()) != nil else { return false }
  p.waitUntilExit()
  return p.terminationStatus == 0
}

// Dropped files paste their escaped paths into the terminal, like Terminal.app.
// (A web page can't see real file paths, so this has to happen natively.)
final class DropWebView: WKWebView {
  override init(frame: CGRect, configuration: WKWebViewConfiguration) {
    super.init(frame: frame, configuration: configuration)
    registerForDraggedTypes([.fileURL])
  }
  required init?(coder: NSCoder) { fatalError() }

  func urls(_ info: NSDraggingInfo) -> [URL] {
    info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
  }
  override func draggingEntered(_ info: NSDraggingInfo) -> NSDragOperation { urls(info).isEmpty ? super.draggingEntered(info) : .copy }
  override func draggingUpdated(_ info: NSDraggingInfo) -> NSDragOperation { urls(info).isEmpty ? super.draggingUpdated(info) : .copy }
  override func performDragOperation(_ info: NSDraggingInfo) -> Bool {
    let files = urls(info)
    if files.isEmpty { return super.performDragOperation(info) }
    let text = files.map { Self.escape($0.path) }.joined(separator: " ") + " "
    let pt = convert(info.draggingLocation, from: nil)
    let json = String(data: try! JSONSerialization.data(withJSONObject: [text]), encoding: .utf8)!
    evaluateJavaScript("window.dropPaths(\(json)[0], \(pt.x), \(isFlipped ? pt.y : bounds.height - pt.y))")
    return true
  }
  static func escape(_ s: String) -> String {
    let special = Set(" \\'\"()[]{}&;|<>$`!*?#~")
    return String(s.flatMap { special.contains($0) ? ["\\", $0] : [$0] })
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
  var window: NSWindow!
  var web: WKWebView!
  var keepAgents = false
  var staged: URL?          // a downloaded, verified Moontty.app waiting to replace this one
  var stagedVersion = ""
  var relaunchAfterUpdate = false
  var checking = false

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()

    let config = WKWebViewConfiguration()
    config.userContentController.add(self, name: "deck")
    let mark = WKUserScript(source: "document.documentElement.classList.add('native')", injectionTime: .atDocumentStart, forMainFrameOnly: true)
    config.userContentController.addUserScript(mark)
    web = DropWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.setValue(false, forKey: "drawsBackground")

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1500, height: 940),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable],
                      backing: .buffered, defer: false)
    window.title = "Moontty"
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.appearance = NSAppearance(named: .darkAqua)
    window.backgroundColor = NSColor(red: 0.118, green: 0.118, blue: 0.118, alpha: 1)
    window.minSize = NSSize(width: 900, height: 560)
    window.contentView = web
    window.center()
    window.setFrameAutosaveName("MoonttyMain")
    window.delegate = self
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    web.loadHTMLString(splash("Moontty is waking up…"), baseURL: nil)
    startUpdates()
    ensureServer { ok in
      if ok { self.web.load(URLRequest(url: deckURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)) }
      else { self.web.loadHTMLString(self.splash("Could not start the server. See ~/.agent-deck/server.log"), baseURL: nil) }
    }
  }

  // Closing the window quits, through the same check, so a cancelled quit keeps the window open.
  func windowShouldClose(_ sender: NSWindow) -> Bool { NSApp.terminate(nil); return false }

  // Quit = stop everything. Agents still busy or waiting on you get a confirm first.
  func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
    if keepAgents { return .terminateNow }
    web.evaluateJavaScript("[...panes.values()].filter((p) => p.info.status === 'working' || p.info.status === 'waiting').length") { r, _ in
      let busy = (r as? Int) ?? 0
      if busy > 0 {
        let a = NSAlert()
        a.messageText = busy == 1 ? "1 agent is still working" : "\(busy) agents are still working"
        a.informativeText = "Quitting stops every agent and shell. Conversations stay saved in Claude Code."
        a.addButton(withTitle: "Quit and stop all")
        a.addButton(withTitle: "Cancel")
        if a.runModal() != .alertFirstButtonReturn { return app.reply(toApplicationShouldTerminate: false) }
      }
      self.stopEverything()
      app.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }

  // A staged update swaps in once this process is gone, whichever way the app quits.
  func applicationWillTerminate(_ note: Notification) { installUpdate() }

  @objc func quitKeepingAgents() { keepAgents = true; NSApp.terminate(nil) }

  func stopEverything() {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["\(deckDir)/deck", "stop", "--all"]
    try? p.run()
    p.waitUntilExit()
  }

  // MARK: server

  func ping(_ done: @escaping (Bool) -> Void) {
    var req = URLRequest(url: deckURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
    req.timeoutInterval = 1
    URLSession.shared.dataTask(with: req) { _, resp, _ in
      done((resp as? HTTPURLResponse)?.statusCode == 200)
    }.resume()
  }

  func ensureServer(_ done: @escaping (Bool) -> Void) {
    ping { up in
      if up { return DispatchQueue.main.async { done(true) } }
      // Detach with nohup so the server (and every agent) outlives the app.
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/bin/zsh")
      // A login shell, so the server sees the user's PATH (gh, brew tools) like a terminal would.
      // The packaged app also (re)installs the Claude Code hook on every start; it is idempotent.
      let setup = bundled ? "DECK_HOOK=~/.agent-deck/hook.sh '\(nodePath)' '\(deckDir)/setup.js' >> ~/.agent-deck/setup.log 2>&1; " : ""
      p.arguments = ["-lc", "mkdir -p ~/.agent-deck; \(setup)nohup '\(nodePath)' '\(deckDir)/server.js' >> ~/.agent-deck/server.log 2>&1 &"]
      try? p.run()
      self.waitForServer(tries: 40, done)
    }
  }

  func waitForServer(tries: Int, _ done: @escaping (Bool) -> Void) {
    ping { up in
      if up || tries == 0 { return DispatchQueue.main.async { done(up) } }
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) { self.waitForServer(tries: tries - 1, done) }
    }
  }

  @objc func stopAll() {
    let a = NSAlert()
    a.messageText = "End the shift?"
    a.informativeText = "Every mission, ZERO and its crew will be stood down. Conversations stay saved in Claude Code."
    a.addButton(withTitle: "Stop all")
    a.addButton(withTitle: "Cancel")
    guard a.runModal() == .alertFirstButtonReturn else { return }
    // Agents live in dtach and outlive the server, so ending the shift goes through `deck stop --all`.
    stopEverything()
    web.loadHTMLString(splash("Shift ended. Standing up a fresh one…"), baseURL: nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
      self.ensureServer { ok in if ok { self.web.load(URLRequest(url: deckURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)) } }
    }
  }

  // MARK: updates
  // The packaged app keeps itself current: it checks on launch and every 6 hours, downloads the
  // new dmg in the background, then offers a relaunch. Say "Later" and it installs on the next quit.
  // Agents survive either way: the swap only detaches the server, and the new one re-attaches them.

  func startUpdates() {
    guard bundled else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { self.checkForUpdates(nil) }
    Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { _ in self.checkForUpdates(nil) }
  }

  @objc func checkForUpdates(_ sender: Any?) {
    let manual = sender != nil
    guard bundled else {
      if manual { tell("This is a dev build", "It runs straight from the repo, so update it with git pull.") }
      return
    }
    if staged != nil { if manual { offerRelaunch() }; return }
    if checking { return }
    checking = true
    var req = URLRequest(url: releasesAPI, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
    req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    URLSession.shared.dataTask(with: req) { data, _, _ in
      let done = { (title: String?, text: String) in
        DispatchQueue.main.async { self.checking = false; if manual, let title { self.tell(title, text) } }
      }
      guard let data, let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let tag = json["tag_name"] as? String else { return done("Couldn't check for updates", "GitHub didn't answer. Try again in a bit.") }
      let version = String(tag.drop(while: { $0 == "v" }))
      guard isNewer(version, than: appVersion) else { return done("Moontty is up to date", "You have \(appVersion), the latest release.") }
      let assets = json["assets"] as? [[String: Any]] ?? []
      guard let link = (assets.first { $0["name"] as? String == dmgName }?["browser_download_url"] as? String).flatMap(URL.init(string:))
      else { return done("Moontty \(version) is out", "But it has no \(dmgName) yet. Try again later.") }
      URLSession.shared.downloadTask(with: link) { file, _, _ in
        // the downloaded file is deleted when this handler returns, so unpack it right here
        let app = file.flatMap { self.unpack($0) }
        DispatchQueue.main.async {
          self.checking = false
          guard let app else { if manual { self.tell("The update didn't download", "Moontty will try again later.") }; return }
          self.staged = app
          self.stagedVersion = version
          self.offerRelaunch()
        }
      }.resume()
    }.resume()
  }

  // Copies the app out of the dmg next to this one (same disk, so the final swap is a rename) and checks it.
  func unpack(_ dmg: URL) -> URL? {
    let mount = FileManager.default.temporaryDirectory.appendingPathComponent("moontty-update-\(UUID().uuidString)")
    let dest = URL(fileURLWithPath: Bundle.main.bundlePath).deletingLastPathComponent().appendingPathComponent(".Moontty-update.app")
    guard run("/usr/bin/hdiutil", ["attach", dmg.path, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount.path]) else { return nil }
    defer { run("/usr/bin/hdiutil", ["detach", mount.path, "-force"]) }
    try? FileManager.default.removeItem(at: dest)
    guard run("/usr/bin/ditto", [mount.appendingPathComponent("Moontty.app").path, dest.path]),
          Bundle(url: dest)?.bundleIdentifier == Bundle.main.bundleIdentifier,
          run("/usr/bin/codesign", ["--verify", "--deep", dest.path])
    else { try? FileManager.default.removeItem(at: dest); return nil }
    run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", dest.path])
    return dest
  }

  func offerRelaunch() {
    let a = NSAlert()
    a.messageText = "Moontty \(stagedVersion) is ready"
    a.informativeText = "Relaunch to update. Your agents keep running and come back as they were. If you wait, it installs the next time you quit."
    a.addButton(withTitle: "Relaunch now")
    a.addButton(withTitle: "Later")
    a.beginSheetModal(for: window) { r in
      guard r == .alertFirstButtonReturn else { return }
      self.relaunchAfterUpdate = true
      self.keepAgents = true
      NSApp.terminate(nil)
    }
  }

  func installUpdate() {
    guard let new = staged else { return }
    // Detach the old server (agents stay in dtach) so the next launch starts the new one.
    run("/bin/zsh", ["\(deckDir)/deck", "stop"])
    // Swap once this process has exited, put the old app back if the move fails, then reopen.
    let swap = """
      while kill -0 $PID 2>/dev/null; do sleep 0.2; done
      rm -rf "$OLD.old"; mv "$OLD" "$OLD.old" && { mv "$NEW" "$OLD" || mv "$OLD.old" "$OLD"; }; rm -rf "$OLD.old"
      [ "$RELAUNCH" = 1 ] && open "$OLD"
      """
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-c", swap]
    p.environment = ["PID": String(getpid()), "OLD": Bundle.main.bundlePath, "NEW": new.path, "RELAUNCH": relaunchAfterUpdate ? "1" : "0", "PATH": "/usr/bin:/bin"]
    try? p.run()
  }

  func tell(_ title: String, _ text: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    a.beginSheetModal(for: window)
  }

  // MARK: bridge from the page (notifications + dock badge)

  func userContentController(_ c: WKUserContentController, didReceive msg: WKScriptMessage) {
    guard let body = msg.body as? [String: Any], let kind = body["kind"] as? String else { return }
    if kind == "badge" {
      let n = body["count"] as? Int ?? 0
      NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
    } else if kind == "notify", !NSApp.isActive {
      let n = NSUserNotification()
      n.title = body["title"] as? String ?? "Moontty"
      n.informativeText = body["body"] as? String
      n.soundName = NSUserNotificationDefaultSoundName
      NSUserNotificationCenter.default.deliver(n)
      NSApp.requestUserAttention(.informationalRequest)
    }
  }

  // window.confirm() in the page (End mission) needs a native dialog
  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    done(a.runModal() == .alertFirstButtonReturn)
  }

  // Server restarts drop the page; retry instead of showing a blank window.
  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.ensureServer { ok in if ok { w.load(URLRequest(url: deckURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)) } } }
  }

  // MARK: menu

  func js(_ s: String) { web.evaluateJavaScript(s) }
  @objc func newMission() { js("quickShell()") }
  @objc func newMissionDialog() { js("openNew()") }
  @objc func toggleWall() { js("document.getElementById('wallBtn').click()") }
  @objc func reload() { web.load(URLRequest(url: deckURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)) }

  func buildMenu() {
    let main = NSMenu()
    func add(_ title: String, _ items: [NSMenuItem]) {
      let top = NSMenuItem()
      let m = NSMenu(title: title)
      items.forEach(m.addItem)
      top.submenu = m
      main.addItem(top)
    }
    func item(_ t: String, _ a: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: t, action: a, keyEquivalent: k)
      i.keyEquivalentModifierMask = mods
      return i
    }
    add("Moontty", [
      item("About Moontty", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
      item("Check for Updates…", #selector(checkForUpdates(_:)), ""),
      .separator(),
      item("Hide Moontty", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      .separator(),
      item("Quit Moontty", #selector(NSApplication.terminate(_:)), "q"),
      item("Quit, keep agents running", #selector(quitKeepingAgents), "q", [.command, .option]),
    ])
    add("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    add("Missions", [
      item("New Shell", #selector(newMission), "n"),
      item("New Mission…", #selector(newMissionDialog), "n", [.command, .shift]),
      item("Overview", #selector(toggleWall), "0"),
      .separator(),
      item("Reload", #selector(reload), "r"),
      item("End Shift (Stop All Agents)…", #selector(stopAll), ""),
    ])
    add("Window", [
      item("Minimize", #selector(NSWindow.miniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.zoom(_:)), ""),
      item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    NSApp.mainMenu = main
  }

  func splash(_ text: String) -> String {
    """
    <html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1e1e;color:#9a9a9a;font:600 12px Menlo,monospace;letter-spacing:2px;text-transform:uppercase">
    <div style="text-align:center"><svg width="44" height="44" viewBox="0 0 24 24" style="margin-bottom:16px;filter:drop-shadow(0 0 10px #e3a23a)"><path d="M15.5 3.2A9 9 0 1 0 20.8 17 7.2 7.2 0 0 1 15.5 3.2Z" fill="#e3a23a"/></svg><br>\(text)</div></body></html>
    """
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
