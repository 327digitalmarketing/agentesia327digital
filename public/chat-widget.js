(function () {
  const script = document.currentScript;
  const clientId = script.getAttribute('data-client-id');
  const apiBase = script.src.replace('/chat-widget.js', '');
  const userId = 'user_' + Math.random().toString(36).substr(2, 9);

  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    #ai-chat-widget * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    #ai-chat-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 99999;
      width: 60px; height: 60px; border-radius: 50%;
      background: #2563eb; color: #fff; border: none; cursor: pointer;
      box-shadow: 0 4px 20px rgba(37,99,235,0.4);
      font-size: 26px; display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s;
    }
    #ai-chat-btn:hover { transform: scale(1.08); }
    #ai-chat-window {
      position: fixed; bottom: 96px; right: 24px; z-index: 99998;
      width: 360px; max-height: 520px;
      background: #fff; border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.15);
      display: flex; flex-direction: column; overflow: hidden;
      transition: opacity 0.2s, transform 0.2s;
    }
    #ai-chat-window.hidden { opacity: 0; pointer-events: none; transform: translateY(10px); }
    #ai-chat-header {
      background: #2563eb; color: #fff;
      padding: 16px 20px; font-weight: 600; font-size: 15px;
      display: flex; align-items: center; gap: 10px;
    }
    #ai-chat-header span.dot {
      width: 10px; height: 10px; background: #4ade80;
      border-radius: 50%; display: inline-block;
    }
    #ai-chat-messages {
      flex: 1; overflow-y: auto; padding: 16px;
      display: flex; flex-direction: column; gap: 10px;
      min-height: 200px; max-height: 340px;
    }
    .ai-msg {
      max-width: 80%; padding: 10px 14px;
      border-radius: 12px; font-size: 14px; line-height: 1.5;
    }
    .ai-msg.bot { background: #f1f5f9; color: #1e293b; align-self: flex-start; border-bottom-left-radius: 4px; }
    .ai-msg.user { background: #2563eb; color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
    .ai-msg.typing { color: #94a3b8; font-style: italic; }
    #ai-chat-input-row {
      display: flex; gap: 8px; padding: 12px 16px;
      border-top: 1px solid #e2e8f0;
    }
    #ai-chat-input {
      flex: 1; border: 1px solid #e2e8f0; border-radius: 8px;
      padding: 8px 12px; font-size: 14px; outline: none;
      transition: border-color 0.2s;
    }
    #ai-chat-input:focus { border-color: #2563eb; }
    #ai-chat-send {
      background: #2563eb; color: #fff; border: none;
      border-radius: 8px; padding: 8px 16px; cursor: pointer;
      font-size: 14px; font-weight: 600; transition: background 0.2s;
    }
    #ai-chat-send:hover { background: #1d4ed8; }
    #ai-chat-send:disabled { background: #94a3b8; cursor: not-allowed; }
  `;
  document.head.appendChild(style);

  // Build HTML
  const container = document.createElement('div');
  container.id = 'ai-chat-widget';
  container.innerHTML = `
    <div id="ai-chat-window" class="hidden">
      <div id="ai-chat-header">
        <span class="dot"></span>
        <span id="ai-chat-title">Asistente Virtual</span>
      </div>
      <div id="ai-chat-messages"></div>
      <div id="ai-chat-input-row">
        <input id="ai-chat-input" type="text" placeholder="Escribe tu mensaje..." />
        <button id="ai-chat-send">Enviar</button>
      </div>
    </div>
    <button id="ai-chat-btn" title="Abrir chat">💬</button>
  `;
  document.body.appendChild(container);

  const btn = document.getElementById('ai-chat-btn');
  const window_ = document.getElementById('ai-chat-window');
  const messages = document.getElementById('ai-chat-messages');
  const input = document.getElementById('ai-chat-input');
  const send = document.getElementById('ai-chat-send');

  let isOpen = false;

  // Toggle
  btn.addEventListener('click', function () {
    isOpen = !isOpen;
    window_.classList.toggle('hidden', !isOpen);
    btn.textContent = isOpen ? '✕' : '💬';
    if (isOpen && messages.children.length === 0) {
      addMessage('bot', '¡Hola! ¿En qué puedo ayudarte hoy?');
    }
    if (isOpen) input.focus();
  });

  // Send message
  function addMessage(type, text) {
    const div = document.createElement('div');
    div.className = 'ai-msg ' + type;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    send.disabled = true;
    addMessage('user', text);

    const typing = addMessage('bot typing', 'Escribiendo...');

    try {
      const res = await fetch(apiBase + '/api/agent/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, userId, message: text }),
      });
      const data = await res.json();
      typing.remove();
      addMessage('bot', data.reply || 'Lo siento, hubo un error.');
    } catch (e) {
      typing.remove();
      addMessage('bot', 'Error de conexión. Intenta de nuevo.');
    }

    send.disabled = false;
    input.focus();
  }

  send.addEventListener('click', sendMessage);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendMessage();
  });

  // Load client name
  fetch(apiBase + '/api/client/' + clientId)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.name) {
        document.getElementById('ai-chat-title').textContent = d.name;
      }
    })
    .catch(function () {});
})();
