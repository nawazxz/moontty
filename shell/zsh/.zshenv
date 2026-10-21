# Moontty starts zsh with ZDOTDIR pointing here. Hand zsh straight back to your own
# config (so .zprofile/.zshrc load as usual), then add grey history hints once it is up.
if [[ -n "${MOONTTY_ZDOTDIR+x}" ]]; then ZDOTDIR=$MOONTTY_ZDOTDIR; unset MOONTTY_ZDOTDIR; else unset ZDOTDIR; fi
_moontty_dir=${${(%):-%x}:A:h}
[[ -f "${ZDOTDIR:-$HOME}/.zshenv" ]] && source "${ZDOTDIR:-$HOME}/.zshenv"

if [[ -o interactive && -z "$MOONTTY_NO_HINTS" ]]; then
  # Runs before the first prompt, after your .zshrc, so a plugin you already load wins.
  _moontty_hints() {
    precmd_functions=(${precmd_functions:#_moontty_hints})
    setopt inc_append_history # every pane's commands are hints in the others straight away
    if (( ! $+functions[_zsh_autosuggest_start] )); then
      source "$_moontty_dir/zsh-autosuggestions.zsh"
      _zsh_autosuggest_start
    fi
    unset _moontty_dir
  }
  precmd_functions+=(_moontty_hints)
else
  unset _moontty_dir
fi
