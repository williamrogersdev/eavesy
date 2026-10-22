// Microsoft Teams (work and personal), joined as an anonymous guest from the browser.
(() => {
  const e = window.__eavesy;
  if (!e || e.adapters.teams) return;

  const tileName = (el) => {
    const tile = el.closest('[data-tid*="participant"], [data-cid], [role="menuitem"], li') || el;
    return tile.getAttribute('aria-label') || tile.querySelector('[data-tid*="name"]')?.innerText || '';
  };

  e.adapters.teams = {
    nameInput: () => document.querySelector('[data-tid="prejoin-display-name-input"], input[placeholder="Type your name"], input[placeholder="Enter your name"]'),
    join: /^(join now|join meeting|continue on this browser|join on the web instead)$/i,
    micOff: /^(mute mic|microphone on|mute)/i,
    camOff: /^(turn camera off|camera on)/i,
    dismiss: /^(continue without audio or video|dismiss|got it|not now|close)$/i,
    leave: /^(leave|hang up)$/i,
    lobby: /someone will let you in shortly|we've let people in the meeting know you're waiting|when the meeting starts, we'll let people know|waiting for someone to let you in/i,
    denied: /sorry, but you were denied access|you've been removed from this meeting|your request to join was declined|no one let you in/i,
    ended: /the meeting has ended|you left the meeting|you've left the meeting|thanks for joining|call ended/i,
    signIn: /sign in to join this meeting|you need to sign in|only people with access/i,
    notFound: /this meeting link is (invalid|expired)|we couldn't find the meeting|meeting not found/i,
    alone: /waiting for others to join|you're the only one here/i,
    count: () => e.countIn(e.findButton(/^(people|participants|show participants)/i)),
    speaking: () =>
      [...document.querySelectorAll('[data-is-speaking="true"], [data-tid="voice-level-stream-outline"]')]
        .map((el) => tileName(el).split(',')[0]),
    participants: () =>
      [...document.querySelectorAll('[data-tid^="participantsInCall-"], [data-tid="roster-participant"] [title], [data-cid="calling-participant-stream"]')]
        .map((el) => el.getAttribute('title') || el.getAttribute('aria-label') || el.innerText),
    announce: (message) => {
      if (!document.querySelector('[data-tid="ckeditor"], [role="textbox"][contenteditable="true"]')) e.click(/^(chat|show conversation|open chat)$/i);
      const box = document.querySelector('[data-tid="ckeditor"], [role="textbox"][contenteditable="true"]');
      if (!box) return false;
      box.focus();
      document.execCommand('insertText', false, message);
      return e.click(/^send$/i);
    },
  };
})();
