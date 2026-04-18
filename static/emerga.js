/**
 * emerga.js — NavPath Ambulance v4
 * Emerga — hands-free voice AI agent.
 * Listens for voice commands: "critical", "urgent", "routine", "sos".
 * Depends on: app.js, ui.js
 */

let emergaRecognition = null;
let emergaActive      = false;

window.initEmerga = function () {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    console.warn('[Emerga] Speech Recognition not supported in this browser.');
    return;
  }

  emergaRecognition             = new SpeechRec();
  emergaRecognition.continuous  = true;
  emergaRecognition.interimResults = false;

  emergaRecognition.onresult = event => {
    const transcript = event.results[event.results.length - 1][0].transcript.toLowerCase();
    console.log('[Emerga] Heard:', transcript);
    if      (transcript.includes('critical')) setPrio('critical');
    else if (transcript.includes('urgent'))   setPrio('urgent');
    else if (transcript.includes('routine'))  setPrio('routine');
    else if (transcript.includes('sos'))      { setPrio('critical'); doSOS(); }
  };

  emergaRecognition.onstart = () => {
    document.getElementById('emergaAgent')?.classList.add('listening');
    toast('🎙️ Emerga listening...');
  };

  emergaRecognition.onend = () => {
    if (emergaActive) {
      try { emergaRecognition.start(); } catch (_) {}
    } else {
      document.getElementById('emergaAgent')?.classList.remove('listening');
    }
  };
};

window.toggleEmerga = function () {
  if (!emergaRecognition) {
    initEmerga();
    if (!emergaRecognition) { toast('Voice recognition not supported'); return; }
  }

  emergaActive = !emergaActive;

  if (emergaActive) {
    try { emergaRecognition.start(); } catch (_) {}
  } else {
    emergaRecognition.stop();
    document.getElementById('emergaAgent')?.classList.remove('listening');
    toast('Emerga voice agent paused.');
  }
};

// Auto-initialise silently after page load
setTimeout(() => window.initEmerga(), 2000);
