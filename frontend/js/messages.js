/**
 * PicShare Messages — messages.js
 * Handles: Socket.IO connection, messaging UI, WebRTC calls, location sharing.
 *
 * Dependencies (loaded before this script):
 *  - api.js      → window.PicShareAPI
 *  - socket.io   → window.io
 *  - leaflet     → window.L
 */
(() => {
  'use strict';

  // ── Helpers ────────────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = v => v == null ? '' : String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = u => (u?.name || u?.username || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase();
  function avatarHtml(user, cls = '') {
    const src = window.PicShareAPI?.image(user?.avatarUrl);
    return `<span class="avatar ${cls}">${src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : esc(initials(user))}</span>`;
  }
  function relativeTime(date) {
    const d = new Date(date);
    if (!Number.isFinite(d.getTime())) return '';
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function isSameDay(a, b) {
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
  }
  function formatDate(date) {
    const d = new Date(date);
    const now = new Date();
    if (isSameDay(d, now)) return 'Today';
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (isSameDay(d, yesterday)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  }
  function formatDuration(s) {
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  let toastTimer;
  function toast(msg, duration = 3000) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), duration);
  }

  function openModal(id) {
    const m = $(`#${id}`); if (!m) return;
    m.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeModal(id) {
    const m = $(`#${id}`); if (!m) return;
    m.hidden = true;
    if (!$$('.modal-backdrop:not([hidden])').length) document.body.style.overflow = '';
  }

  // ── App state ──────────────────────────────────────────────────────────────
  const state = {
    user: null,
    conversations: [],
    activeConvId: null,
    activePeer: null,
    messages: [],
    hasMoreMessages: false,
    loadingMessages: false,
    onlineUsers: new Set(),
    typingUsers: new Map(), // convId → { userId, timer }
    socket: null,
    // WebRTC
    call: {
      id: null,
      state: 'idle', // idle|outgoing|incoming|ringing|connecting|connected|ended
      type: null,
      peer: null,
      pc: null,         // RTCPeerConnection
      localStream: null,
      remoteStream: null,
      durationTimer: null,
      durationSeconds: 0
    },
    // Live location
    liveLocSession: null,
    liveLocWatcher: null,
    liveLocTimer: null
  };

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function boot() {
    if (!window.PicShareAPI) {
      window.location.href = '/';
      return;
    }
    if (!PicShareAPI.token) {
      window.location.href = '/';
      return;
    }

    try {
      const data = await PicShareAPI.get('/users/me');
      state.user = data.user;
      const settings = await PicShareAPI.get('/settings').catch(() => ({}));
      state.browserNotify = settings.privacy?.notifications !== false;
    } catch {
      window.location.href = '/';
      return;
    }

    $('#messages-app').hidden = false;
    attachEventListeners();
    connectSocket();
    await loadConversations();

    // If ?conv=<id> in URL, open that conversation
    const params = new URLSearchParams(window.location.search);
    const convId = params.get('conv');
    const userId = params.get('user');
    if (convId) {
      openConversationById(convId);
    } else if (userId) {
      startOrOpenDm(userId);
    }
  }

  // ── Socket.IO ──────────────────────────────────────────────────────────────
  function connectSocket() {
    const API_BASE = PicShareAPI.origin;

    state.socket = io(API_BASE, {
      auth: { token: PicShareAPI.token, messenger: true },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1500
    });

    const socket = state.socket;

    socket.on('connect', () => {
      console.log('[socket] connected');
      // Rejoin active conversation room
      if (state.activeConvId) {
        socket.emit('conversation:join', { conversationId: state.activeConvId });
        recoverMessages(state.activeConvId).catch(err => toast(err.message));
      }
      loadConversations();
    });

    socket.on('connect_error', err => {
      console.warn('[socket] connect error:', err.message);
    });

    socket.on('disconnect', () => {
      console.log('[socket] disconnected');
    });

    // Presence
    socket.on('presence:online', ({ userId }) => {
      state.onlineUsers.add(String(userId));
      updatePresenceUI(String(userId), true);
    });
    socket.on('presence:offline', ({ userId }) => {
      state.onlineUsers.delete(String(userId));
      updatePresenceUI(String(userId), false);
    });

    // New message
    socket.on('message:new', ({ message }) => {
      if (!message) return;
      const convId = String(message.conversation || message.conversationId || '');
      if (String(message.sender?._id || message.sender) !== String(state.user._id)) socket.emit('message:received', { conversationId: convId, messageId: message._id });
      if (convId === state.activeConvId) {
        // Append to thread
        appendMessage(message);
        scrollToBottom();
        // Mark read
        if (document.visibilityState === 'visible') markRead(convId);
      }
      if (document.visibilityState !== 'visible' && state.browserNotify && !state.conversations.find(c => String(c._id) === convId)?.preferences?.muted && window.Notification?.permission === 'granted' && String(message.sender?._id || message.sender) !== String(state.user._id)) new Notification('PicShare', { body: 'You have a new message.', tag: message._id });
      // Update conversation list preview
      updateConvPreview(convId, message);
    });

    // Delivery/read events
    socket.on('message:delivered', ({ messageId }) => updateMessageStatus(messageId, 'delivered'));
    socket.on('message:read', ({ messageId }) => updateMessageStatus(messageId, 'read'));

    socket.on('conversation:read', ({ conversationId, readBy, through, at }) => {
      if (conversationId === state.activeConvId && readBy !== String(state.user._id)) state.messages.filter(m => String(m.sender?._id || m.sender) === String(state.user._id) && (m.createdAt < at || m.createdAt === at && m._id <= through)).forEach(m => updateMessageStatus(m._id, 'read'));
    });
    socket.on('message:changed', ({ message }) => {
      if (String(message.conversation) !== state.activeConvId) return;
      const i = state.messages.findIndex(m => m._id === message._id);
      if (i >= 0) { state.messages[i] = message; renderMessages(state.messages); }
    });
    socket.on('location:updated', ({ sessionId }) => refreshLiveView(sessionId));
    socket.on('location:ended', ({ sessionId }) => refreshLiveView(sessionId));

    // Typing
    socket.on('typing:start', ({ conversationId, userId, username }) => {
      if (String(conversationId) !== state.activeConvId) return;
      showTyping(userId, username);
    });
    socket.on('typing:stop', ({ conversationId, userId }) => {
      if (String(conversationId) !== state.activeConvId) return;
      hideTyping(userId);
    });

    // Call events
    socket.on('call:incoming', handleIncomingCall);
    socket.on('call:outgoing', ({ callId, callType, recipientId }) => {
      state.call.id = callId;
      state.call.state = 'ringing';
      state.call.type = callType;
      showCallOverlay('Calling…');
    });
    socket.on('call:answered', async ({ callId }) => {
      if (state.call.id !== callId) return;
      state.call.state = 'connecting';
      showCallOverlay('Connecting…');
      // Caller creates offer
      if (state.call.isCaller) { try { await createAndSendOffer(); } catch (err) { socket.emit('call:end', { callId }); endCallCleanup('failed'); } }
    });
    socket.on('call:offer', async ({ callId, sdp }) => {
      if (state.call.id !== callId || state.call.state !== 'connecting' || state.call.isCaller) return;
      try { await handleRemoteOffer(sdp); } catch (err) { socket.emit('call:end', { callId }); endCallCleanup('failed'); }
    });
    socket.on('call:answer_sdp', async ({ callId, sdp }) => {
      if (state.call.id !== callId) return;
      try { await handleRemoteAnswer(sdp); } catch (err) { socket.emit('call:end', { callId }); endCallCleanup('failed'); }
    });
    socket.on('call:ice', async ({ callId, candidate }) => {
      if (state.call.id !== callId) return;
      try {
        if (state.call.pc?.remoteDescription && candidate) await state.call.pc.addIceCandidate(new RTCIceCandidate(candidate));
        else (state.call.iceQueue ||= []).push(candidate);
      } catch (e) { console.warn('[ice] addIceCandidate error:', e.message); }
    });
    socket.on('call:ended', ({ callId, reason, durationSeconds }) => {
      if (state.call.id !== callId && callId) return;
      endCallCleanup(reason, durationSeconds);
    });
    socket.on('call:error', ({ error }) => {
      toast(error || 'Call failed.');
      endCallCleanup('failed');
    });

    // Live location relay
    if (state.liveLocSession) {
      socket.on(`location:update:${state.liveLocSession._id}`, ({ lat, lng, at }) => {
        updateLiveLocationMap(lat, lng, at);
      });
    }
  }

  // ── Conversations ──────────────────────────────────────────────────────────
  async function loadConversations() {
    const list = $('#conv-list');
    try {
      const data = await PicShareAPI.get('/conversations');
      state.conversations = data.conversations || [];
      renderConvList(state.conversations);
    } catch (err) {
      list.innerHTML = `<p class="muted" style="padding:16px;font-size:12px">Failed to load conversations. ${esc(err.message)}</p>`;
    }
  }

  function renderConvList(conversations) {
    const list = $('#conv-list');
    if (!conversations.length) {
      list.innerHTML = `<div style="padding:30px 16px;text-align:center;color:var(--muted);font-size:13px">No conversations yet.<br>Start one with a friend!</div>`;
      return;
    }
    list.innerHTML = conversations.map(conv => convItemHtml(conv)).join('');
  }

  function convItemHtml(conv) {
    const peer = conv.participant;
    const online = peer && state.onlineUsers.has(String(peer._id));
    const unread = Number(conv.unreadCount || 0);
    const lastMsg = conv.lastMessage;
    let preview = '';
    if (lastMsg) {
      preview = lastMsg.type === 'text' ? esc(lastMsg.text || '') : `[${lastMsg.type || 'message'}]`;
    }
    return `<div class="conv-item${state.activeConvId === String(conv._id) ? ' active' : ''}" 
      data-conv-id="${esc(conv._id)}" 
      data-peer-id="${esc(peer?._id)}"
      role="listitem"
      tabindex="0"
      aria-label="Conversation with ${esc(peer?.name || peer?.username)}">
      <div class="conv-item-avatar">
        ${avatarHtml(peer, '')}
        <span class="online-dot ${online ? 'online' : ''}"></span>
      </div>
      <div class="conv-item-body">
        <div class="conv-item-row">
          <span class="conv-item-name">${conv.preferences?.pinned ? '⌖ ' : ''}${esc(peer?.name || peer?.username || 'Unknown')}${conv.preferences?.muted ? ' · muted' : ''}</span>
          <span class="conv-item-time">${lastMsg?.at ? relativeTime(lastMsg.at) : ''}</span>
        </div>
        <div class="conv-item-preview ${unread ? 'font-weight:700' : ''}">${preview || '@' + esc(peer?.username || '')}</div>
      </div>
      ${unread ? `<div class="conv-item-unread">${unread > 99 ? '99+' : unread}</div>` : ''}
    </div>`;
  }

  function updateConvPreview(convId, message) {
    const conv = state.conversations.find(c => String(c._id) === convId);
    if (!conv) { loadConversations(); return; }
    if (conv) {
      conv.lastMessage = { text: message.text, type: message.type, sender: message.sender?._id, at: message.createdAt };
      if (convId !== state.activeConvId && String(message.sender?._id || message.sender) !== String(state.user._id)) conv.unreadCount = (conv.unreadCount || 0) + 1;
    }
    renderConvList(state.conversations);
  }

  // ── Open conversation ──────────────────────────────────────────────────────
  async function openConversationById(convId) {
    // Already open?
    if (state.activeConvId === convId) return;

    // Leave previous room
    if (state.activeConvId && state.socket) {
      state.socket.emit('conversation:leave', { conversationId: state.activeConvId });
    }

    $('#conversation-details').hidden = true;
    state.activeConvId = convId;
    const conv = state.conversations.find(c => String(c._id) === convId);
    state.activePeer = conv?.participant || null;

    // Join socket room
    if (state.socket) state.socket.emit('conversation:join', { conversationId: convId });

    // Show thread, hide empty state
    $('#conv-empty-state').hidden = true;
    const thread = $('#conv-thread');
    thread.hidden = false;

    // Mobile: hide sidebar
    $('#conv-sidebar').classList.add('hidden-mobile');

    // Update header
    renderThreadHeader();

    // Mark active in list
    $$('.conv-item').forEach(el => el.classList.toggle('active', el.dataset.convId === convId));

    // Load messages
    await loadMessages(convId, true);

    // Mark as read
    await markRead(convId);
  }

  async function startOrOpenDm(userId) {
    try {
      const data = await PicShareAPI.post('/conversations', { recipientId: userId });
      const conv = data.conversation;
      // Add to list if not already there
      if (!state.conversations.find(c => String(c._id) === String(conv._id))) {
        state.conversations.unshift(conv);
        renderConvList(state.conversations);
      }
      await openConversationById(String(conv._id));
    } catch (err) {
      toast(err.message || 'Could not start conversation.');
    }
  }

  function renderThreadHeader() {
    const peer = state.activePeer;
    $('#thread-peer-avatar').innerHTML = avatarHtml(peer);
    $('#thread-peer-name').textContent = peer?.name || peer?.username || 'Unknown';
    updatePresenceUI(peer?._id, state.onlineUsers.has(String(peer?._id)));
  }

  function updatePresenceUI(userId, online) {
    // Thread header status
    if (state.activePeer && String(state.activePeer._id) === String(userId)) {
      const statusEl = $('#thread-peer-status');
      if (statusEl) {
        statusEl.textContent = online ? 'online' : 'offline';
        statusEl.className = 'thread-peer-status' + (online ? ' online' : '');
      }
    }
    // Conversation list dot
    $$(`.conv-item[data-peer-id="${CSS.escape(String(userId))}"]`).forEach(el => {
      const dot = el.querySelector('.online-dot');
      if (dot) dot.classList.toggle('online', Boolean(online));
    });
  }

  // ── Messages ───────────────────────────────────────────────────────────────
  async function loadMessages(convId, replace = true) {
    if (state.loadingMessages) return;
    state.loadingMessages = true;
    const container = $('#thread-messages');

    if (replace) {
      container.innerHTML = '<div class="date-separator">Loading…</div>';
      state.messages = [];
    }

    try {
      const oldest = state.messages[0];
      const url = `/conversations/${convId}/messages?limit=30${oldest ? `&before=${oldest._id}` : ''}`;
      const data = await PicShareAPI.get(url);
      if (convId !== state.activeConvId) return;
      const msgs = data.messages || [];
      for (const message of msgs) state.socket?.emit('message:received', { conversationId: convId, messageId: message._id });
      state.hasMoreMessages = data.hasMore;
      state.messages = [...msgs, ...state.messages];

      if (replace) {
        renderMessages(state.messages);
        scrollToBottom();
      } else {
        // Prepend older messages
        const oldScrollHeight = container.scrollHeight;
        prependMessages(msgs);
        container.scrollTop = container.scrollHeight - oldScrollHeight;
      }
    } catch (err) {
      if (replace) container.innerHTML = `<div class="date-separator">${esc(err.message)}</div>`;
    } finally {
      state.loadingMessages = false;
    }
  }

  function renderMessages(messages) {
    const container = $('#thread-messages');
    container.innerHTML = '';
    if (!messages.length) {
      container.innerHTML = '<div class="date-separator">Say hello! 👋</div>';
      return;
    }

    // Load more sentinel
    if (state.hasMoreMessages) {
      const sentinel = document.createElement('div');
      sentinel.className = 'date-separator load-more-sentinel';
      sentinel.setAttribute('role', 'button');
      sentinel.setAttribute('tabindex', '0');
      sentinel.textContent = '↑ Load older messages';
      sentinel.style.cursor = 'pointer';
      sentinel.addEventListener('click', () => loadMessages(state.activeConvId, false));
      sentinel.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loadMessages(state.activeConvId, false); } });
      container.appendChild(sentinel);
    }

    let prevDate = null, unreadShown = false;
    messages.forEach(msg => {
      if (!unreadShown && String(msg.sender?._id || msg.sender) !== String(state.user._id) && !msg.readBy?.[state.user._id] && !msg.deleted) { const unread = document.createElement('div'); unread.className = 'date-separator'; unread.textContent = 'Unread messages'; container.appendChild(unread); unreadShown = true; }
      // Date separator
      if (!prevDate || !isSameDay(prevDate, msg.createdAt)) {
        const sep = document.createElement('div');
        sep.className = 'date-separator';
        sep.textContent = formatDate(msg.createdAt);
        container.appendChild(sep);
        prevDate = msg.createdAt;
      }
      container.appendChild(buildMessageEl(msg));
    });
  }

  function prependMessages(messages) {
    const container = $('#thread-messages');
    const frag = document.createDocumentFragment();
    let prevDate = null, unreadShown = false;
    messages.forEach(msg => {
      if (!prevDate || !isSameDay(prevDate, msg.createdAt)) {
        const sep = document.createElement('div');
        sep.className = 'date-separator';
        sep.textContent = formatDate(msg.createdAt);
        frag.appendChild(sep);
        prevDate = msg.createdAt;
      }
      frag.appendChild(buildMessageEl(msg));
    });
    // Insert after first child (load-more sentinel or nothing)
    const sentinel = container.querySelector('.load-more-sentinel');
    container.insertBefore(frag, sentinel?.nextSibling || container.firstChild);
  }

  function appendMessage(message) {
    const container = $('#thread-messages');
    if (state.messages.some(m => String(m._id) === String(message._id))) return;
    if (!state.messages.length) container.innerHTML = '';
    // Date separator if needed
    const lastMsg = state.messages[state.messages.length - 1];
    if (!lastMsg || !isSameDay(lastMsg.createdAt, message.createdAt)) {
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.textContent = formatDate(message.createdAt);
      container.appendChild(sep);
    }
    state.messages.push(message);
    if (lastMsg && (lastMsg.createdAt > message.createdAt || lastMsg.createdAt === message.createdAt && String(lastMsg._id) > String(message._id))) { state.messages.sort((a,b) => a.createdAt.localeCompare(b.createdAt) || String(a._id).localeCompare(String(b._id))); renderMessages(state.messages); return; }
    container.appendChild(buildMessageEl(message));
  }

  function buildMessageEl(msg) {
    const mine = String(msg.sender?._id || msg.sender) === String(state.user?._id);
    const row = document.createElement('div');
    row.className = `msg-row ${mine ? 'mine' : 'theirs'}`;
    row.dataset.msgId = msg._id;

    if (!mine) {
      row.insertAdjacentHTML('afterbegin', avatarHtml(msg.sender, 'msg-group-avatar'));
    }

    const bubble = document.createElement('div');
    bubble.className = `msg-bubble${msg.deleted ? ' deleted' : ''}`;

    if (msg.deleted) {
      bubble.textContent = 'This message was deleted';
    } else if (msg.type === 'text') {
      bubble.innerHTML = esc(msg.text).replace(/\n/g, '<br>');
    } else if (msg.type === 'image') {
      bubble.classList.add('msg-image');
      bubble.classList.remove('msg-bubble');
      const img = document.createElement('img');
      if (msg.imageUrl.startsWith('/api/conversations/')) {
        fetch(PicShareAPI.origin + msg.imageUrl, { headers: { Authorization: `Bearer ${PicShareAPI.token}` } }).then(response => { if (!response.ok) throw new Error(); return response.blob(); }).then(blob => { const url = URL.createObjectURL(blob); img.onload = () => URL.revokeObjectURL(url); img.src = url; }).catch(() => { img.alt = 'Image unavailable'; });
      } else img.src = PicShareAPI.image(msg.imageUrl);
      img.alt = 'Shared image';
      img.loading = 'lazy';
      img.style.maxWidth = '240px';
      img.style.borderRadius = '14px';
      img.style.display = 'block';
      bubble.appendChild(img);
    } else if (msg.type === 'location') {
      bubble.classList.add('msg-location');
      bubble.classList.remove('msg-bubble');
      const lat = msg.location?.lat, lng = msg.location?.lng;
      const mapId = `map-${msg._id}`;
      bubble.innerHTML = `
        <div class="msg-location-map" id="${mapId}"></div>
        <div class="msg-location-footer">
          <span class="msg-location-label">📍 ${esc(msg.location?.label || 'Location')}</span>
          <a class="msg-location-open" href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}&zoom=15" target="_blank" rel="noopener">Open map</a>
        </div>`;
      setTimeout(() => renderMiniMap(mapId, lat, lng), 100);
    } else if (msg.type === 'live_location') {
      bubble.classList.add('msg-live-location');
      const sessionId = msg.location?.sessionId;
      bubble.innerHTML = `<span class="live-dot"></span><strong>Live location shared</strong>
        ${sessionId ? `<br><button class="text-link" style="margin-top:6px;font-size:11px" data-view-live="${sessionId}">View live location →</button>` : ''}`;
    } else if (msg.type === 'call_summary') {
      bubble.innerHTML = `<div class="msg-call-summary">
        <span class="msg-call-icon">${msg.callRef?.callType === 'video' ? '📹' : '📞'}</span>
        <div>${esc(msg.text || 'Call ended')}</div>
      </div>`;
    }

    if (msg.replyTo) { const reply = document.createElement('small'); reply.textContent = 'Reply: ' + (msg.replyTo.text || '[message]'); bubble.prepend(reply, document.createElement('br')); }
    if (msg.type === 'post_share' && !msg.deleted && !msg.postRef) bubble.textContent = 'Post is no longer available.';
    if (msg.type === 'post_share' && !msg.deleted && msg.postRef) { const link = document.createElement('a'); link.href = '/?post=' + encodeURIComponent(msg.postRef?._id || msg.postRef); link.textContent = msg.postRef?.caption || msg.text || 'View shared post';
      if (msg.postRef?.imageUrl) { const image = document.createElement('img'); image.src = PicShareAPI.image(msg.postRef.imageUrl); image.alt = 'Shared post'; image.style.cssText = 'max-width:180px;display:block;border-radius:8px'; link.prepend(image); }
      bubble.appendChild(link); }
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const time = new Date(msg.createdAt);
    meta.innerHTML = `${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${mine ? ` <span class="msg-status">${statusIcon(msg.deliveryState)}</span>` : ''}`;

    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.alignItems = mine ? 'flex-end' : 'flex-start';
    wrap.style.gap = '2px';
    wrap.appendChild(bubble);
    wrap.appendChild(meta);
    row.appendChild(wrap);
    if (!msg.deleted) {
      const actions = document.createElement('div'); actions.className = 'message-actions';
      const button = (label, action) => { const b = document.createElement('button'); b.className = 'text-link'; b.textContent = label; b.onclick = action; actions.appendChild(b); };
      button('Reply', () => { replyTo = msg._id; toast('Replying to ' + (msg.text || msg.type)); $('#msg-text').focus(); });
      if (msg.type === 'text') button('Forward', async () => { const username = prompt('Forward to which username?'); if (!username) return; try { const data = await PicShareAPI.get(`/users/search?q=${encodeURIComponent(username)}`); const recipient = data.users.find(u => u.username === username.toLowerCase().replace(/^@/, '')); if (!recipient) throw new Error('User not found.'); const { conversation } = await PicShareAPI.post('/conversations', { recipientId: recipient._id }); await PicShareAPI.post(`/conversations/messages/${msg._id}/forward`, { conversationId: conversation._id, idempotencyKey: crypto.randomUUID() }); toast('Message forwarded.'); } catch (e) { toast(e.message); } });
      button('♡', async () => { try { await PicShareAPI.patch(`/conversations/messages/${msg._id}`, { reaction: '❤️' }); } catch (e) { toast(e.message); } });
      if (mine && msg.type === 'text') button('Edit', async () => { const text = prompt('Edit message', msg.text); if (text) try { await PicShareAPI.patch(`/conversations/messages/${msg._id}`, { text }); } catch (e) { toast(e.message); } });
      if (mine) button('Delete', async () => { try { await PicShareAPI.delete(`/conversations/messages/${msg._id}`); } catch (e) { toast(e.message); } });
      const reactions = document.createElement('span'); reactions.textContent = Object.values(msg.reactions || {}).join(' ');
      actions.appendChild(reactions); wrap.appendChild(actions);
    }
    return row;
  }

  function statusIcon(state) {
    if (state === 'read') return '✓✓';
    if (state === 'delivered') return '✓✓';
    return '✓';
  }

  function updateMessageStatus(messageId, status) {
    const el = $(`[data-msg-id="${CSS.escape(messageId)}"]`);
    if (!el) return;
    const statusEl = el.querySelector('.msg-status');
    if (statusEl) statusEl.textContent = statusIcon(status);
  }

  function scrollToBottom() {
    const container = $('#thread-messages');
    container.scrollTop = container.scrollHeight;
  }

  // ── Leaflet mini maps ──────────────────────────────────────────────────────
  function renderMiniMap(containerId, lat, lng) {
    if (!window.L) return;
    const el = document.getElementById(containerId);
    if (!el || el._leaflet_id) return;
    try {
      const map = L.map(el, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, keyboard: false });
      L.tileLayer(window.PICSHARE_MAP_TILES || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
      map.setView([lat, lng], 15);
      L.marker([lat, lng]).addTo(map);
    } catch (e) { console.warn('Mini map error:', e.message); }
  }

  // ── Mark read ──────────────────────────────────────────────────────────────
  async function markRead(convId) {
    try {
      const through = state.messages.at(-1)?._id;
      if (!through || convId !== state.activeConvId || document.visibilityState !== 'visible') return;
      await PicShareAPI.patch(`/conversations/${convId}/read`, { through });
      const conv = state.conversations.find(c => String(c._id) === convId);
      if (conv) { conv.unreadCount = 0; renderConvList(state.conversations); }
    } catch { /* non-critical */ }
  }

  // ── Typing ─────────────────────────────────────────────────────────────────
  let typingTimer;
  let isTyping = false;

  function handleTypingInput() {
    if (!state.socket || !state.activeConvId) return;
    if (!isTyping) {
      isTyping = true;
      state.socket.emit('typing:start', { conversationId: state.activeConvId });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      isTyping = false;
      state.socket.emit('typing:stop', { conversationId: state.activeConvId });
    }, 2000);
  }

  function showTyping(userId, username) {
    const indicator = $('#typing-indicator');
    const label = $('#typing-label');
    indicator.hidden = false;
    label.textContent = `${username || 'Someone'} is typing…`;
    // Auto-hide
    clearTimeout(state.typingUsers.get(userId)?.timer);
    state.typingUsers.set(userId, {
      timer: setTimeout(() => hideTyping(userId), 5500)
    });
  }

  function hideTyping(userId) {
    state.typingUsers.delete(userId);
    if (!state.typingUsers.size) $('#typing-indicator').hidden = true;
  }

  // ── Send message ───────────────────────────────────────────────────────────
  let replyTo = null;
  async function sendMessage(type, payload) {
    if (!state.activeConvId) return;
    const conversationId = state.activeConvId;
    const body = { type, idempotencyKey: crypto.randomUUID(), ...payload, ...(replyTo ? { replyTo } : {}) };
    const pending = document.createElement('p'); pending.className = 'msg-meta'; pending.textContent = 'Sending…'; $('#thread-messages').appendChild(pending);
    const send = async () => {
      const data = await PicShareAPI.post(`/conversations/${conversationId}/messages`, body);
      if (conversationId === state.activeConvId) { appendMessage(data.message); scrollToBottom(); }
      updateConvPreview(conversationId, data.message);
      replyTo = null; pending.remove();
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await send(); return true; }
      catch (err) {
        if (err.status && err.status < 500 || attempt === 2) {
          pending.remove();
          toast(err.message || 'Message failed.');
          const retry = document.createElement('button');
          retry.className = 'text-link';
          retry.textContent = 'Message failed — retry';
          retry.onclick = async () => { retry.disabled = true; try { await send(); retry.remove(); } catch (e) { toast(e.message); retry.disabled = false; } };
          $('#thread-messages').appendChild(retry);
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }

  async function recoverMessages(conversationId) {
    let cursor = state.messages.at(-1)?._id;
    if (!cursor) { await loadMessages(conversationId, true); return; }
    let more = true;
    while (more && conversationId === state.activeConvId) {
      const data = await PicShareAPI.get(`/conversations/${conversationId}/messages?after=${cursor}&limit=50`);
      if (conversationId !== state.activeConvId) return;
      for (const message of data.messages) appendMessage(message);
      more = data.hasMore && data.messages.length > 0;
      cursor = data.messages.at(-1)?._id || cursor;
    }
    const loaded = [...state.messages];
    for (let i = 0; i < loaded.length && conversationId === state.activeConvId; i += 50) {
      const data = await PicShareAPI.post(`/conversations/${conversationId}/messages/state`, { ids: loaded.slice(i,i+50).map(m => m._id) });
      if (conversationId !== state.activeConvId) return;
      for (const message of data.messages) { const index = state.messages.findIndex(m => m._id === message._id); if (index >= 0) state.messages[index] = message; }
    }
    renderMessages(state.messages);
    if (document.visibilityState === 'visible') markRead(conversationId);
  }

  // ── Location sharing ───────────────────────────────────────────────────────
  async function shareCurrentLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation is not supported by your browser.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        pos => resolve(pos),
        err => {
          const messages = {
            1: 'Location access was denied. Please allow location access in your browser settings.',
            2: 'Your location is currently unavailable.',
            3: 'Location request timed out.'
          };
          reject(new Error(messages[err.code] || 'Location unavailable.'));
        },
        { timeout: 10000, maximumAge: 30000 }
      );
    });
  }

  async function sendOneTimeLocation() {
    toast('Getting your location…');
    try {
      const pos = await shareCurrentLocation();
      const { latitude: lat, longitude: lng } = pos.coords;
      if (!confirm(`Share this location with ${state.activePeer?.name || 'this conversation'}? Latitude ${lat.toFixed(4)}, longitude ${lng.toFixed(4)}. Choose Cancel to discard.`)) return;
      await sendMessage('location', {
        location: { lat, lng, label: 'My location' }
      });
    } catch (err) {
      toast(err.message);
    }
  }

  async function startLiveLocation(durationMinutes) {
    closeModal('live-location-modal');
    try {
      if (state.liveLocSession) await stopLiveLocation();
      if (state.liveLocSession) return;
      await shareCurrentLocation();
      const data = await PicShareAPI.post('/locations/live', {
        conversationId: state.activeConvId,
        durationMinutes
      });
      state.liveLocSession = data.session;

      // Send a message in the conversation
      await sendMessage('live_location', {
        text: `Live location shared for ${durationMinutes < 60 ? durationMinutes + ' minutes' : (durationMinutes / 60) + ' hour(s)'}`,
        location: { sessionId: data.session._id }
      });

      // Start watching position
      if (!navigator.geolocation) {
        toast('Geolocation not supported.');
        return;
      }
      state.liveLocWatcher = navigator.geolocation.watchPosition(
        async pos => {
          const { latitude: lat, longitude: lng, accuracy } = pos.coords;
          try {
            await PicShareAPI.patch(`/locations/live/${data.session._id}`, { lat, lng, accuracy });

          } catch (err) { toast(err.message); if (err.status === 410 || err.status === 403) stopLiveLocation(); }
        },
        err => { toast(err.message); stopLiveLocation(); },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
      );

      // Show banner
      const banner = $('#live-loc-banner');
      banner.hidden = false;
      const expiry = new Date(data.session.expiresAt);
      updateLiveLocBanner(expiry);
      state.liveLocTimer = setInterval(() => {
        if (new Date() >= expiry) stopLiveLocation();
        else updateLiveLocBanner(expiry);
      }, 30000);

      toast('Live location sharing started.');
    } catch (err) {
      toast(err.message || 'Could not start live location.');
    }
  }

  function updateLiveLocBanner(expiresAt) {
    const remaining = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
    const text = $('#live-loc-banner-text');
    if (text) text.textContent = `Sharing live location · ${remaining} min left`;
  }

  async function stopLiveLocation() {
    if (!state.liveLocSession) return;
    if (state.liveLocWatcher != null) navigator.geolocation.clearWatch(state.liveLocWatcher);
    state.liveLocWatcher = null;
    clearInterval(state.liveLocTimer);
    try {
      await PicShareAPI.delete(`/locations/live/${state.liveLocSession._id}`);
    } catch (err) { toast('Tracking stopped locally; server revocation is pending. Retry Stop Sharing. ' + err.message); return; }
    if (state.liveLocWatcher != null) navigator.geolocation.clearWatch(state.liveLocWatcher);
    clearInterval(state.liveLocTimer);
    state.liveLocSession = null;
    state.liveLocWatcher = null;
    $('#live-loc-banner').hidden = true;
    toast('Stopped sharing live location.');
  }

  async function refreshLiveView(sessionId) {
    const button = document.querySelector(`[data-view-live="${CSS.escape(sessionId)}"][data-open="true"]`);
    if (!button) return;
    let display = button.parentElement.querySelector('.live-position');
    if (!display) { display = document.createElement('div'); display.className = 'live-position'; button.parentElement.appendChild(display); }
    try {
      const data = await PicShareAPI.get(`/locations/live/${sessionId}`);
      display.replaceChildren();
      const label = document.createElement('p');
      label.textContent = data.lat == null ? 'Waiting for location…' : `Updated ${new Date(data.lastUpdatedAt).toLocaleTimeString()} · expires ${new Date(data.expiresAt).toLocaleTimeString()}`;
      display.appendChild(label);
      if (data.lat != null) {
        const map = document.createElement('div'); map.style.cssText = 'height:180px;width:240px;max-width:100%'; display.appendChild(map);
        if (window.L) { const instance = L.map(map).setView([data.lat, data.lng], 15); L.tileLayer(window.PICSHARE_MAP_TILES || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: window.PICSHARE_MAP_ATTRIBUTION || '© OpenStreetMap contributors' }).addTo(instance); L.marker([data.lat, data.lng]).addTo(instance); }
      }
    } catch (err) { display.textContent = err.status === 410 || err.status === 404 ? 'Sharing ended. Location is no longer available.' : err.message; }
  }
  setInterval(() => document.querySelectorAll('[data-view-live][data-open="true"]').forEach(b => refreshLiveView(b.dataset.viewLive)), 10000);
  document.addEventListener('visibilitychange', async () => { if (document.visibilityState !== 'visible' || !state.user) return; try { const settings = await PicShareAPI.get('/settings'); state.browserNotify = settings.privacy?.notifications !== false; if (state.activeConvId && state.socket?.connected) await recoverMessages(state.activeConvId); } catch (err) { toast(err.message); } });

  // ── WebRTC Calling ─────────────────────────────────────────────────────────
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  // TURN credentials from server env (fetched below)
  let turnCredentials = null;

  async function fetchTurnCredentials() {
    try {
      const data = await PicShareAPI.get('/auth/turn-credentials').catch(() => null);
      if (data?.urls) turnCredentials = data;
    } catch { /* TURN is optional */ }
  }

  function getIceServers() {
    return turnCredentials
      ? [...ICE_SERVERS, turnCredentials]
      : ICE_SERVERS;
  }

  async function startCall(callType) {
    if (!state.socket?.connected) { toast('Connect to messaging before calling.'); return; }
    if (!state.activePeer) { toast('Open a conversation first.'); return; }
    if (state.call.state !== 'idle') { toast('You already have an active call.'); return; }

    state.call.state = 'requesting';
    // Permission is requested only in response to the call action.
    try {
      const constraints = callType === 'video'
        ? { audio: true, video: true }
        : { audio: true, video: false };
      state.call.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      toast(`Cannot access ${callType === 'video' ? 'camera/microphone' : 'microphone'}: ${err.message}`);
      endCallCleanup();
      return;
    }

    state.call.isCaller = true;
    state.call.type = callType;
    state.call.peer = state.activePeer;
    state.call.state = 'outgoing';

    showCallOverlay('Calling…');

    if (callType === 'video') {
      const localVideo = $('#local-video');
      localVideo.srcObject = state.call.localStream;
      localVideo.hidden = false;
      $('#remote-video').hidden = false;
    }

    if (state.socket) {
      state.socket.emit('call:invite', {
        recipientId: state.activePeer._id,
        callType,
        conversationId: state.activeConvId
      });
    }
  }

  async function createAndSendOffer() {
    const pc = createPeerConnection();
    state.call.pc = pc;

    // Add local tracks
    if (state.call.localStream) {
      state.call.localStream.getTracks().forEach(track => pc.addTrack(track, state.call.localStream));
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (state.socket) {
      state.socket.emit('call:offer', { callId: state.call.id, sdp: offer });
    }
  }

  async function handleRemoteOffer(sdp) {
    // Recipient got an offer — needs local stream first
    if (!state.call.localStream) {
      try {
        const constraints = state.call.type === 'video' ? { audio: true, video: true } : { audio: true };
        state.call.localStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (state.call.type === 'video') {
          $('#local-video').srcObject = state.call.localStream;
          $('#local-video').hidden = false;
          $('#remote-video').hidden = false;
        }
      } catch (err) {
        toast('Cannot access media: ' + err.message);
        if (state.socket) state.socket.emit('call:reject', { callId: state.call.id });
        endCallCleanup('failed');
        return;
      }
    }

    const pc = createPeerConnection();
    state.call.pc = pc;

    state.call.localStream.getTracks().forEach(track => pc.addTrack(track, state.call.localStream));

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    for (const candidate of (state.call.iceQueue || [])) await pc.addIceCandidate(candidate);
    state.call.iceQueue = [];
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    if (state.socket) {
      state.socket.emit('call:answer_sdp', { callId: state.call.id, sdp: answer });
    }
    state.call.state = 'connecting';
  }

  async function handleRemoteAnswer(sdp) {
    if (!state.call.pc) return;
    await state.call.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    for (const candidate of (state.call.iceQueue || [])) await state.call.pc.addIceCandidate(candidate);
    state.call.iceQueue = [];
  }

  function createPeerConnection() {
    const pc = new RTCPeerConnection({ iceServers: getIceServers() });

    pc.onicecandidate = event => {
      if (event.candidate && state.socket) {
        state.socket.emit('call:ice', { callId: state.call.id, candidate: event.candidate });
      }
    };

    pc.ontrack = event => {
      state.call.remoteStream = event.streams[0];
      const remoteVideo = $('#remote-video');
      const remoteAudio = $('#remote-audio');
      if (state.call.type === 'video') {
        remoteVideo.srcObject = event.streams[0];
      } else {
        remoteAudio.srcObject = event.streams[0];
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        state.socket?.emit('call:connected', { callId: state.call.id });
        clearInterval(state.call.heartbeat);
        state.call.heartbeat = setInterval(() => state.socket?.emit('call:heartbeat', { callId: state.call.id }), 10000);
        state.call.state = 'connected';
        showCallOverlay(null); // Start duration timer
        startCallDurationTimer();
      } else if (['failed', 'disconnected'].includes(pc.connectionState)) {
        state.socket?.emit('call:end', { callId: state.call.id });
        toast('Call connection failed.');
        endCallCleanup('network_error');
      }
    };

    return pc;
  }

  function handleIncomingCall({ callId, callType, callerId, callerName, callerUsername, callerAvatar }) {
    if (state.call.state !== 'idle') {
      // Already in call — send busy
      if (state.socket) state.socket.emit('call:reject', { callId });
      return;
    }

    state.call.id = callId;
    state.call.state = 'incoming';
    state.call.type = callType;

    const incoming = $('#incoming-call');
    $('#incoming-call-avatar').innerHTML = avatarHtml({ name: callerName, username: callerUsername, avatarUrl: callerAvatar });
    $('#incoming-call-name').textContent = callerName || callerUsername || 'Unknown';
    $('#incoming-call-type').textContent = `Incoming ${callType} call`;
    incoming.hidden = false;

    // Auto-reject after 45s
    state.call._incomingTimer = setTimeout(() => {
      incoming.hidden = true;
      state.call.state = 'idle';
    }, 45000);
  }

  function showCallOverlay(statusText) {
    const overlay = $('#call-overlay');
    overlay.hidden = false;
    const peer = state.call.peer || state.activePeer;
    $('#call-peer-avatar').innerHTML = avatarHtml(peer, '');
    $('#call-peer-name').textContent = peer?.name || peer?.username || 'Unknown';
    if (statusText) {
      $('#call-status').textContent = statusText;
      $('#call-status').hidden = false;
      $('#call-duration').hidden = true;
    }
  }

  function startCallDurationTimer() {
    $('#call-status').hidden = true;
    $('#call-duration').hidden = false;
    state.call.durationSeconds = 0;
    clearInterval(state.call.durationTimer);
    state.call.durationTimer = setInterval(() => {
      state.call.durationSeconds++;
      $('#call-duration').textContent = formatDuration(state.call.durationSeconds);
    }, 1000);
  }

  function endCallCleanup(reason, durationSeconds) {
    clearInterval(state.call.durationTimer);
    clearInterval(state.call.heartbeat);
    clearTimeout(state.call._incomingTimer);

    // Stop all media tracks
    state.call.localStream?.getTracks().forEach(t => t.stop());
    state.call.pc?.close();

    // Reset media elements
    ['#remote-video', '#local-video', '#remote-audio'].forEach(sel => {
      const el = $(sel);
      if (el) { el.srcObject = null; el.hidden = true; }
    });

    // Hide UI
    $('#call-overlay').hidden = true;
    $('#incoming-call').hidden = true;

    // Show reason toast
    const reasonMessages = {
      rejected: 'Call was rejected.',
      cancelled: 'Call was cancelled.',
      no_answer: 'No answer.',
      busy: 'User is busy.',
      completed: durationSeconds != null ? `Call ended — ${formatDuration(durationSeconds)}` : 'Call ended.',
      network_error: 'Call ended due to network issue.',
      failed: 'Call failed to connect.'
    };
    if (reason && reason !== 'completed' || (reason === 'completed' && durationSeconds != null)) {
      toast(reasonMessages[reason] || 'Call ended.');
    }

    // Reset state
    state.call = {
      id: null, state: 'idle', type: null, peer: null,
      pc: null, localStream: null, remoteStream: null,
      durationTimer: null, durationSeconds: 0
    };

    // Update button toggles
    $('#call-mute').classList.remove('muted');
    $('#call-cam').classList.remove('cam-off');
  }

  // ── Event listeners ────────────────────────────────────────────────────────
  function attachEventListeners() {
    $('#btn-thread-info').addEventListener('click', async () => {
      const panel = $('#conversation-details'); panel.hidden = !panel.hidden; if (panel.hidden || !state.activeConvId) return;
      try { const { calls } = await PicShareAPI.get(`/conversations/${state.activeConvId}/calls`); const conv = state.conversations.find(c => String(c._id) === state.activeConvId);
        panel.innerHTML = `<button class="text-link" data-conv-pref="pinned">${conv?.preferences?.pinned ? 'Unpin':'Pin'} conversation</button><button class="text-link" data-conv-pref="muted">${conv?.preferences?.muted ? 'Unmute':'Mute'} alerts</button><a class="text-link" href="/?profile=${esc(state.activePeer?._id)}">View profile</a><h3>Call history</h3>${calls.map(c => `<p>${esc(c.callType)} · ${esc(c.endReason || c.state)} · ${esc(new Date(c.createdAt).toLocaleString())} · ${c.durationSeconds || 0}s</p>`).join('') || '<p>No calls yet.</p>'}`;
      } catch (err) { panel.textContent = err.message; }
    });
    $('#conversation-details').addEventListener('click', async e => { const button = e.target.closest('[data-conv-pref]'); if (!button) return; const conv = state.conversations.find(c => String(c._id) === state.activeConvId); const key = button.dataset.convPref; try { await PicShareAPI.patch(`/conversations/${state.activeConvId}/preferences`, { [key]: !conv?.preferences?.[key] }); await loadConversations(); $('#conversation-details').hidden = true; } catch(err) { toast(err.message); } });
    $('#enable-notifications')?.addEventListener('click', async () => {
      if (!window.Notification) { toast('Browser notifications are unavailable. Use this inbox for alerts.'); return; }
      const permission = await Notification.requestPermission();
      toast(permission === 'granted' ? 'Browser notifications enabled while Messages is open.' : 'Use the conversation inbox for notifications.');
    });

    // Back to main app
    $('#back-to-app').addEventListener('click', () => {
      window.location.href = '/';
    });

    // Conversation list click
    $('#conv-list').addEventListener('click', e => {
      const item = e.target.closest('.conv-item');
      if (item) openConversationById(item.dataset.convId);
    });
    $('#conv-list').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const item = e.target.closest('.conv-item');
        if (item) openConversationById(item.dataset.convId);
      }
    });

    // Mobile back button
    $('#thread-back').addEventListener('click', () => {
      $('#conv-sidebar').classList.remove('hidden-mobile');
      $('#conv-thread').hidden = true;
      state.activeConvId = null;
    });

    // New conversation
    ['#new-conv-btn', '#conv-empty-new'].forEach(sel => {
      const el = $(sel);
      if (el) el.addEventListener('click', () => openModal('new-conv-modal'));
    });

    // New conv search
    let newConvTimer;
    $('#new-conv-search').addEventListener('input', () => {
      clearTimeout(newConvTimer);
      const q = $('#new-conv-search').value.trim();
      if (!q) { $('#new-conv-results').innerHTML = ''; return; }
      newConvTimer = setTimeout(() => searchPeopleForNewConv(q), 280);
    });

    // Conversation search filter
    let convSearchTimer;
    $('#conv-search').addEventListener('input', () => {
      clearTimeout(convSearchTimer);
      const q = $('#conv-search').value.trim().toLowerCase();
      convSearchTimer = setTimeout(() => {
        const filtered = state.conversations.filter(c =>
          (c.participant?.name || '').toLowerCase().includes(q) ||
          (c.participant?.username || '').toLowerCase().includes(q)
        );
        renderConvList(q ? filtered : state.conversations);
      }, 200);
    });

    // Message composer
    const msgInput = $('#msg-text');
    const sendBtn = $('#composer-send-btn');

    msgInput.addEventListener('input', () => {
      sendBtn.disabled = !msgInput.value.trim();
      handleTypingInput();
    });

    msgInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) $('#thread-composer').dispatchEvent(new Event('submit'));
      }
    });

    $('#thread-composer').addEventListener('submit', async e => {
      e.preventDefault();
      const text = msgInput.value.trim();
      if (!text || !state.activeConvId) return;
      msgInput.value = '';
      sendBtn.disabled = true;
      isTyping = false;
      if (state.socket) state.socket.emit('typing:stop', { conversationId: state.activeConvId });
      await sendMessage('text', { text });
    });

    // Attach menu
    const attachBtn = $('#composer-attach-btn');
    const attachMenu = $('#composer-attach-menu');
    attachBtn.addEventListener('click', () => {
      attachMenu.hidden = !attachMenu.hidden;
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('#composer-attach-menu') && !e.target.closest('#composer-attach-btn')) {
        attachMenu.hidden = true;
      }
    });

    // Image attachment
    $('#attach-image').addEventListener('click', () => {
      attachMenu.hidden = true;
      $('#msg-image-file').click();
    });
    $('#msg-image-file').addEventListener('change', async () => {
      const file = $('#msg-image-file').files[0];
      if (!file || !state.activeConvId) return;
      if (file.size > 5 * 1024 * 1024) { toast('Image must be under 5 MB.'); return; }

      // Upload via post upload endpoint
      const fd = new FormData();
      fd.append('image', file);
      try {
        toast('Uploading…');
        // We'll reuse the post upload for now and store the URL
        const data = await PicShareAPI.upload(`/conversations/${state.activeConvId}/attachments`, fd);
        // Since we can't upload a standalone image file easily without a dedicated endpoint,
        // we send the imageUrl directly
        const imageUrl = data.imageUrl;
        if (imageUrl) await sendMessage('image', { imageUrl });
      } catch (err) {
        toast('Image upload failed: ' + err.message);
      }
      $('#msg-image-file').value = '';
    });

    // Location
    $('#attach-location').addEventListener('click', () => {
      attachMenu.hidden = true;
      sendOneTimeLocation();
    });

    // Live location
    $('#attach-live-location').addEventListener('click', () => {
      attachMenu.hidden = true;
      openModal('live-location-modal');
    });

    // Duration selection for live location
    $$('.duration-opt').forEach(btn => {
      btn.addEventListener('click', () => startLiveLocation(Number(btn.dataset.duration)));
    });

    // Stop live location
    $('#stop-live-loc-btn').addEventListener('click', stopLiveLocation);

    // Call buttons
    $('#btn-call-audio').addEventListener('click', () => startCall('audio'));
    $('#btn-call-video').addEventListener('click', () => startCall('video'));

    // Call controls
    $('#call-mute').addEventListener('click', () => {
      const track = state.call.localStream?.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      $('#call-mute').classList.toggle('muted', !track.enabled);
      $('#call-mute').title = track.enabled ? 'Mute' : 'Unmute';
    });

    $('#call-cam').addEventListener('click', () => {
      const track = state.call.localStream?.getVideoTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      $('#call-cam').classList.toggle('cam-off', !track.enabled);
    });

    $('#call-end').addEventListener('click', () => {
      if (state.call.id && state.socket) {
        state.socket.emit('call:end', { callId: state.call.id });
      }
      endCallCleanup('completed');
    });

    // Incoming call actions
    $('#incoming-accept').addEventListener('click', async () => {
      clearTimeout(state.call._incomingTimer);
      $('#incoming-call').hidden = true;
      state.call.state = 'connecting';
      if (state.socket) state.socket.emit('call:answer', { callId: state.call.id });
      showCallOverlay('Connecting…');
    });

    $('#incoming-reject').addEventListener('click', () => {
      clearTimeout(state.call._incomingTimer);
      $('#incoming-call').hidden = true;
      if (state.socket && state.call.id) {
        state.socket.emit('call:reject', { callId: state.call.id });
      }
      state.call.state = 'idle';
      state.call.id = null;
    });

    // Modal close buttons
    document.addEventListener('click', e => {
      const close = e.target.closest('[data-close]');
      if (close) closeModal(close.dataset.close);
      // Click outside modal
      const backdrop = e.target.closest('.modal-backdrop');
      if (backdrop && e.target === backdrop) closeModal(backdrop.id);
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        $$('.modal-backdrop:not([hidden])').forEach(m => closeModal(m.id));
      }
    });

    // Thread message actions (delegated)
    $('#thread-messages').addEventListener('click', async e => {
      const viewLive = e.target.closest('[data-view-live]');
      if (viewLive) {
        viewLive.dataset.open = 'true';
        await refreshLiveView(viewLive.dataset.viewLive);
      }

      const deleteBtn = e.target.closest('[data-delete-msg]');
      if (deleteBtn) {
        const msgId = deleteBtn.dataset.deleteMsg;
        if (!confirm('Delete this message?')) return;
        try {
          await PicShareAPI.delete(`/conversations/messages/${msgId}`);
          const el = $(`[data-msg-id="${CSS.escape(msgId)}"]`);
          if (el) {
            const bubble = el.querySelector('.msg-bubble');
            if (bubble) { bubble.classList.add('deleted'); bubble.textContent = 'This message was deleted'; }
          }
        } catch (err) { toast(err.message); }
      }
    });
  }

  // ── New conversation people search ─────────────────────────────────────────
  async function searchPeopleForNewConv(q) {
    const results = $('#new-conv-results');
    results.innerHTML = '<p class="muted" style="font-size:12px;padding:8px">Searching…</p>';
    try {
      const data = await PicShareAPI.get(`/users/search?q=${encodeURIComponent(q)}`);
      const users = (data.users || []).filter(u => !u.isMe);
      if (!users.length) {
        results.innerHTML = '<p class="muted" style="font-size:12px;padding:8px">No users found.</p>';
        return;
      }
      results.innerHTML = users.map(u => `
        <div class="new-conv-person" data-user-id="${esc(u._id)}" tabindex="0" role="button" aria-label="Message ${esc(u.name || u.username)}">
          ${avatarHtml(u)}
          <div class="new-conv-person-info">
            <strong>${esc(u.name)}</strong>
            <span>@${esc(u.username)}</span>
          </div>
        </div>
      `).join('');

      results.querySelectorAll('.new-conv-person').forEach(el => {
        const open = () => {
          closeModal('new-conv-modal');
          startOrOpenDm(el.dataset.userId);
        };
        el.addEventListener('click', open);
        el.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
      });
    } catch (err) {
      results.innerHTML = `<p class="form-error" style="padding:8px">${esc(err.message)}</p>`;
    }
  }

  // ── Add "Messages" link to main app when running on /messages.html ─────────
  // This page is standalone; main app navigation is via back button

  // ── Initialize ─────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    // Pre-fetch TURN credentials (optional, non-blocking)
    fetchTurnCredentials().catch(() => {});
    boot();
  });

})();
