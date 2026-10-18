// Moontty.app: a native window around the agent-deck server.
// The server runs detached, so quitting the app is a "detach": agents keep working.
import Cocoa
import WebKit

let deckDir = Bundle.main.object(forInfoDictionaryKey: "DeckDir") as? String ?? NSHomeDirectory() + "/agent-deck"
let nodePath = Bundle.main.object(forInfoDictionaryKey: "NodePath") as? String ?? "/usr/local/bin/node"
let port = 7681
let deckURL = URL(string: "http://localhost:\(port)")!

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

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
  var window: NSWindow!
  var web: WKWebView!

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
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    web.loadHTMLString(splash("Moontty is waking up…"), baseURL: nil)
    ensureServer { ok in
      if ok { self.web.load(URLRequest(url: deckURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)) }
      else { self.web.loadHTMLString(self.splash("Could not start the server. See ~/.agent-deck/server.log"), baseURL: nil) }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

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
      p.arguments = ["-c", "mkdir -p ~/.agent-deck; nohup '\(nodePath)' '\(deckDir)/server.js' >> ~/.agent-deck/server.log 2>&1 &"]
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
    let p = Process()
    // Agents live in dtach and outlive the server, so ending the shift goes through `deck stop --all`.
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["\(deckDir)/deck", "stop", "--all"]
    try? p.run()
    p.waitUntilExit()
    web.loadHTMLString(splash("Shift ended. Standing up a fresh one…"), baseURL: nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
      self.ensureServer { ok in if ok { self.web.load(URLRequest(url: deckURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)) } }
    }
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
  @objc func newMission() { js("openNew()") }
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
      .separator(),
      item("Hide Moontty", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      .separator(),
      item("Quit (agents keep running)", #selector(NSApplication.terminate(_:)), "q"),
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
      item("Deploy Mission", #selector(newMission), "n"),
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
