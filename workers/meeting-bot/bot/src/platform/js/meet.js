// Google Meet, joined as a signed-out guest.
(() => {
  const e = window.__eavesy;
  if (!e || e.adapters.meet) return;

  // Meet marks the speaking participant's tile with an animated ring; the
  // tile's aria text and an audio-level attribute are the stable signals.
  const tiles = () => [...document.querySelectorAll('[data-participant-id]')];
  const tileName = (tile) =>
    tile.querySelector('[data-self-name]')?.innerText || tile.getAttribute('aria-label') || (tile.innerText || '').split('\n')[0];

  e.adapters.meet = {
    nameInput: () => document.querySelector('input[aria-label="Your name"], input[placeholder="Your name"], input[autocomplete="name"]'),
    join: /^(ask to join|join now|join anyway|switch here)$/i,
    micOff: /^turn off microphone/i,
    camOff: /^turn off camera/i,
    dismiss: /^(got it|dismiss|close|continue without microphone and camera|no thanks)$/i,
    leave: /^leave call$/i,
    lobby: /asking to be let in|you'll join the call when someone lets you in|someone in the call will let you in|please wait until a meeting host/i,
    denied: /you can't join this call|denied your request|no one responded to your request|you've been removed|you were removed/i,
    ended: /you left the meeting|you've left the meeting|the call has ended|the meeting has ended|return to home screen/i,
    signIn: /sign in to join|sign in with your google account|you can't join this video call/i,
    notFound: /check your meeting code|meeting code (is )?(not valid|invalid)|this meeting link is (invalid|not valid)|invalid video call name/i,
    alone: /you're the only one here|no one else is here/i,
    count: () => e.countIn(e.findButton(/^(show everyone|people|participants)/i)),
    speaking: () =>
      tiles()
        .filter((t) => /\bspeaking\b/i.test(t.getAttribute('aria-label') || '') || t.querySelector('[data-audio-level]:not([data-audio-level="0"])'))
        .map(tileName),
    participants: () => tiles().map(tileName),
    announce: (message) => {
      if (!e.findButton(/^send a message$|^send message$/i)) e.click(/^(chat with everyone|open chat|chat)$/i);
      const box = document.querySelector('textarea[aria-label="Send a message"], textarea[placeholder="Send a message"]');
      if (!e.setInput(box, message)) return false;
      return e.click(/^(send a message|send message)$/i);
    },
  };
})();
