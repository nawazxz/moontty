#!/bin/sh
# Claude Code hook for every Moontty event: forwards the hook's JSON to the
# server that owns this pane. Outside a Moontty pane it does nothing. It must
# stay silent on stdout and never block Claude.
[ -n "$AGENT_DECK_ID" ] || exit 0
curl -s --max-time 1 -o /dev/null -X POST \
  -H "X-Deck-Id: $AGENT_DECK_ID" -H 'Content-Type: application/json' \
  --data-binary @- "http://127.0.0.1:${AGENT_DECK_PORT:-7681}/hook" 2>/dev/null
exit 0
