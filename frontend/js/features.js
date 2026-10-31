(() => {
  const api = window.PicShareAPI;
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const core = () => window.PicShareCore;
  const root = () => $('#feature-view');
  const user = () => core().state.user;
  const tabs = () => `<nav class="feature-tabs" aria-label="Discover sections">${[['discover','Photography'],['challenges','Photo Quest'],['collections','Collections'],['spaces','Circles & albums'],['bookmarks','Saved'],['nearby','Photo map'],['analytics','Creator studio'],['settings','Privacy & safety'],['notifications','Notifications']].map(([key,label]) => `<button data-feature="${key}" class="${page.name === key ? 'active' : ''}">${label}</button>`).join('')}</nav>`;
  const heading = (title, subtitle = '') => `<div class="feature-heading"><div><p class="eyebrow">PICSHARE / ${esc(page.name)}</p><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div></div>${tabs()}`;
  const empty = message => `<div class="feature-empty">${esc(message)}</div>`;
  const photoGrid = (posts, collectionId) => posts.length ? `<div class="photo-grid">${posts.map(p => `<figure class="photo-tile"><button class="photo-open" data-photo="${esc(p._id)}" aria-label="Open photo by ${esc(p.author?.username)}"><img src="${esc(api.image(p.imageUrl))}" alt="${esc(p.altText || p.caption || 'Shared photo')}" loading="lazy"></button><figcaption class="photo-caption"><strong data-profile="${esc(p.author?._id)}">@${esc(p.author?.username || 'creator')}</strong><span>${esc(p.caption?.slice(0,120))}</span><small>${Number(p.likesCount ?? p.likes?.length ?? 0)} likes · ${Number(p.commentsCount || 0)} comments</small>${collectionId ? `<button class="text-link" data-remove-from-collection="${p._id}" data-current-collection="${collectionId}">Remove from collection</button>` : ''}</figcaption></figure>`).join('')}</div>` : empty('No photos here yet. Share a moment to start the story.');
  const input = (label, name, type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" ${extra}></label>`;
  const select = (label, name, choices, selected) => `<label>${label}<select name="${name}">${choices.map(([value,label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
  let realtime = null, photoMap = null;
  let page = { name:'discover' }, version = 0, stories = [], storyIndex = 0, searchTimer, discoveryCursor, discoveryRequest = 0;
  function mount(html) { root().innerHTML = html; window.PicShareContacts?.mount(); }
  function error(err) { core().toast(err.message || 'Please try again.'); }
  async function open(name, id) {
    if (!user()) return;
    core().state.view = name === 'discover' ? 'explore' : 'feature';
    if (photoMap) { photoMap.remove(); photoMap = null; }
    page = { name, id }; const generation = ++version;
    ['feed-view','explore-view','profile-view'].forEach(key => { $('#' + key).hidden = true; });
    root().hidden = false; mount('<div class="skeleton-grid" aria-label="Loading" role="status"></div>');
    window.scrollTo({ top:0 });
    try {
      const html = await render(name, id);
      if (generation === version) { mount(html); if (name === 'nearby') await drawPhotoMap(); }
    } catch (err) { if (generation === version) mount(heading('Something needs attention') + `<p class="feature-error" role="alert">${esc(err.message)}</p><button class="btn btn-secondary" data-retry-feature>Try again</button>`); }
  }
  async function render(name, id) {
    if (name === 'discover') {
      discoveryCursor = null;
      const data = await api.get('/discover'); discoveryCursor = data.nextCursor;
      return '<div data-contact-tools></div>' + heading('See a little differently.', 'Photography, people, and a daily invitation to notice more.') + `<form id="discover-form" class="feature-search"><input id="discover-search" name="q" type="search" maxlength="80" placeholder="Search photos, captions, hashtags or creators" aria-label="Search photography"><select name="mode" aria-label="Sort photographs"><option value="recent">Recent</option><option value="trending">Trending this week</option></select><button class="btn btn-primary">Search</button></form><div class="field-pair">${select('Category','discover-category',[['','All categories'],...['nature','travel','architecture','portraits','street','food'].map(s => [s,s])])}${select('Mood','discover-mood',[['','All moods'],...['cinematic','peaceful','vibrant','minimal'].map(s => [s,s])])}</div><div class="filter-row">${data.hashtags.map(t => `<button data-tag="${esc(t._id)}">${esc(t._id)}</button>`).join('')}</div><p class="muted small" id="discovery-explanation">${esc(data.ranking)}</p><div id="discover-creators"></div><div id="discovery-grid">${photoGrid(data.posts)}</div><button class="btn btn-secondary" id="discover-more" ${!data.hasMore ? 'hidden' : ''}>More photographs</button><h2>Public collections</h2><div id="discover-collections" class="resource-grid">${data.collections.map(c => `<button class="resource-card" data-collection="${esc(c._id)}"><small>CURATED BY @${esc(c.owner?.username)}</small><strong>${esc(c.name)}</strong></button>`).join('') || empty('Public collections will appear here.')}</div>`;
    }
    if (name === 'post') {
      const { post } = await api.get(`/posts/${id}`);
      const related = await api.get(`/discover?category=${encodeURIComponent(post.category || '')}`).catch(() => ({ posts:[] }));
      return heading('A moment worth keeping.') + core().postCard(post) + '<h2>More to notice</h2><p class="muted small">Recent public photos' + (post.category ? ' in ' + esc(post.category) : '') + '.</p>' + photoGrid(related.posts.filter(p => p._id !== post._id).slice(0,6));
    }
    if (name === 'bookmarks') { const data = await api.get('/bookmarks'); return heading('Saved for another look.', 'Your private bookmarks.') + photoGrid(data.posts) + (data.hasMore ? `<button class="btn btn-secondary" data-bookmarks-older="${data.nextCursor}">More saved photos</button>` : ''); }
    if (name === 'collections') { const data = await api.get('/collections'); return heading('Your own way of seeing.', 'Curate photos into public or private collections.') + `<form id="collection-create" class="feature-form"><h2>Start a collection</h2>${input('Name','name','text','required maxlength="80"')}${select('Visibility','visibility',[['private','Private — only you'],['public','Public — discoverable']],'private')}<button class="btn btn-primary">Create collection</button></form><div class="resource-grid">${data.collections.map(c => `<button class="resource-card" data-collection="${c._id}"><small>${esc(c.visibility)} · ${c.posts.length} photos</small><strong>${esc(c.name)}</strong></button>`).join('') || empty('Create your first collection above.')}</div>`; }
    if (name === 'collection') {
      const data = await api.get(`/collections/${id}`);
      return heading(data.collection.name, `${data.collection.visibility} collection`) + photoGrid(data.posts, String(data.collection.owner) === user()._id ? id : null) + (String(data.collection.owner) === user()._id ? `<button class="btn btn-secondary" data-delete-collection="${id}">Delete collection</button>` : '');
    }
    if (name === 'challenges') {
      const { current, challenges } = await api.get('/challenges');
      return heading('Daily Photo Quest.', 'A small prompt. Your interpretation. A new way to notice the everyday.') + `<div class="resource-grid">${[current,...challenges.filter(c => c._id !== current._id)].map(c => `<button class="resource-card" data-challenge="${c._id}"><small>${new Date(c.closesAt) > new Date() ? 'OPEN UNTIL ' : 'ARCHIVE · CLOSED '}${esc(new Date(c.closesAt).toLocaleString())}</small><strong>${esc(c.title)}</strong><p>${esc(c.description)}</p></button>`).join('')}</div>`;
    }
    if (name === 'challenge') {
      const data = await api.get(`/challenges/${id}`);
      const mine = await api.get(`/users/${user()._id}`);
      const active = new Date(data.challenge.closesAt) > new Date();
      return heading(data.challenge.title, data.challenge.description) + `<p class="muted">Closes ${esc(new Date(data.challenge.closesAt).toLocaleString())} · UTC daily prompts</p>${active ? `<form id="challenge-submit" class="feature-form"><h2>Your entry</h2><label>Choose one of your photos<select name="postId" required>${mine.posts.map(p => `<option value="${p._id}">${esc(p.caption || 'Untitled photo')} · ${new Date(p.createdAt).toLocaleDateString()}</option>`).join('')}</select></label><p class="muted small">One entry per person; resubmitting replaces your entry. Your account must be public. You have one vote per challenge and may change it before closing.</p><button class="btn btn-primary">Submit photo</button></form>` : empty('This challenge is closed. Browse the community results below.')}<h2>Community leaderboard</h2><p class="muted small">Votes measure community preference, not creative quality.</p><div class="photo-grid">${data.entries.map((entry, index) => `<figure class="photo-tile"><button class="photo-open" data-photo="${entry.post._id}"><img src="${esc(api.image(entry.post.imageUrl))}" alt="${esc(entry.post.altText || entry.post.caption)}" loading="lazy"></button><figcaption class="photo-caption"><strong>${index+1}. @${esc(entry.post.author?.username)}</strong><span>${entry.votes} ${entry.votes === 1 ? 'vote':'votes'}</span>${active && String(entry.user) !== user()._id ? `<button class="text-link" data-vote="${entry._id}">${String(data.myVote) === String(entry._id) ? 'Your vote ✓':'Vote for this photo'}</button>` : ''}</figcaption></figure>`).join('') || empty('Be the first to interpret this prompt.')}</div>`;
    }
    if (name === 'spaces') {
      const data = await api.get('/spaces');
      return heading('Make room for your people.', 'Private Circles for conversation through photos. Shared albums for memories you build together.') + `<form id="space-create" class="feature-form"><h2>Create a private space</h2>${select('Type','kind',[['circle','Circle — a private photo feed'],['album','Album — collaborative memories']],'circle')}${input('Name','name','text','required maxlength="80"')}<label>Description<textarea name="description" maxlength="500" rows="2"></textarea></label><button class="btn btn-primary">Create space</button></form><div class="resource-grid">${data.spaces.map(s => `<button class="resource-card" data-space="${s._id}"><small>PRIVATE ${esc(s.kind.toUpperCase())}</small><strong>${esc(s.name)}</strong><p>${esc(s.description)}</p><small>Owned by @${esc(s.owner?.username)}</small></button>`).join('') || empty('Create a space or ask a friend to invite your username.')}</div>`;
    }
    if (name === 'space') {
      const data = await api.get(`/spaces/${id}`); const s = data.space;
      const discussion = s.kind === 'circle' ? await api.get(`/spaces/${id}/discussion`) : null;
      return heading(s.name, s.description || `Private ${s.kind}`) + `<p class="muted small">Only current members can load these photos. Removing membership revokes future media access. ${s.kind === 'album' ? 'Memories appear newest first.' : ''}</p>${discussion ? `<section><h2>Circle conversation</h2><div id="circle-messages" class="circle-discussion" role="log" aria-label="Circle conversation">${discussionMessages(discussion.messages)}</div>${discussion.hasMore ? `<button class="text-link" data-circle-older="${discussion.nextCursor}">Older messages</button>` : ''}${data.canUpload ? `<form id="circle-message" class="feature-search"><input name="text" maxlength="2000" required placeholder="A message for your Circle…" aria-label="Circle message"><button class="btn btn-primary">Send</button></form>` : ''}<button class="text-link" data-refresh-circle>Refresh conversation</button></section>` : ''}${data.canUpload ? `<form id="space-upload" class="feature-form"><h2>Add a moment</h2>${input('Photo','image','file','accept="image/jpeg,image/png,image/webp,image/gif" required')}<label>Caption<textarea name="caption" rows="2" maxlength="2200"></textarea></label><button class="btn btn-primary">Share privately</button></form>` : empty('You have view-only access to this album.')}<div class="photo-grid">${data.items.map(item => `<figure class="photo-tile"><button class="photo-open" data-space-item="${item._id}"><img src="${esc(api.image(item.imageUrl))}" alt="${esc(item.caption || 'Private photo')}" loading="lazy"></button><figcaption class="photo-caption"><strong>@${esc(item.author?.username)}</strong><span>${esc(item.caption)}</span><small>${esc(new Date(item.createdAt).toLocaleDateString())}</small><button class="text-link" data-item-comments="${item._id}">Comments</button>${data.canManage || item.author?._id === user()._id ? `<button class="text-link" data-delete-item="${item._id}">Remove photo</button>` : ''}</figcaption></figure>`).join('') || empty('A fresh space for your first memory.')}</div>${data.hasMore ? `<button class="btn btn-secondary" data-space-older="${data.nextCursor}">Older photos</button>` : ''}<h2>Members</h2><p class="muted small">Owner: ${esc(s.owner?.name || s.owner?.username || 'Space owner')}. Invitations grant access immediately; invite only intended recipients.</p>${s.members.map(m => `<div class="member-row"><div><strong>@${esc(m.user?.username || 'deleted account')}</strong><p>${esc(m.role)}</p></div>${data.canManage ? `<button class="text-link" data-remove-member="${m.user?._id}">Remove</button>` : ''}</div>`).join('')}${data.canManage ? `<form id="space-invite" class="feature-form"><h2>Invite by username</h2>${input('Username','username','text','required maxlength="24"')}${select('Role','role',[['contributor','Contributor — upload and comment'],['viewer','Viewer — read only'],...(data.isOwner ? [['moderator','Moderator — manage photos and members']] : [])],'contributor')}<button class="btn btn-primary">Grant access</button></form>` : ''}<div class="feature-actions">${data.isOwner ? `<button class="btn btn-secondary" data-delete-space="${id}">Delete this ${esc(s.kind)}</button>` : `<button class="btn btn-secondary" data-leave-space="${id}">Leave this ${esc(s.kind)}</button>`}</div>`;
    }
    if (name === 'item') {
      const data = await api.get(`/spaces/${page.spaceId}/items/${id}/comments`);
      return heading('The conversation.', 'Private comments stay inside this space.') + `<button class="text-link" data-space="${page.spaceId}">← Back to photos</button><div>${data.comments.map(c => `<div class="notice-row"><div><strong>@${esc(c.author?.username)}</strong><p>${esc(c.text)}</p></div></div>`).join('') || empty('Start the conversation.')}</div><form id="item-comment" class="feature-form">${input('Comment','text','text','required maxlength="500"')}<button class="btn btn-primary">Post comment</button></form>`;
    }
    if (name === 'story-create') return heading('Here for today.', 'Photo stories disappear after 24 hours. Viewers can still save or screenshot what they see.') + `<form id="story-upload" class="feature-form">${input('Photo','image','file','accept="image/jpeg,image/png,image/webp,image/gif" required')}<label>Text overlay<textarea name="text" rows="2" maxlength="500"></textarea></label>${select('Sticker','sticker',[['','None'],['✨','✨'],['☀️','☀️'],['❤️','❤️'],['📍','📍']],'')}${select('Audience','audience',[['public','Public'],['followers','Followers']],'followers')}<button class="btn btn-primary">Share for 24 hours</button></form>`;
    if (name === 'story') {
      const story = stories[storyIndex]; if (!story) return heading('Stories') + empty('No active stories.');
      await api.post(`/stories/${story._id}/view`, {});
      const mine = story.owner._id === user()._id;
      return heading(`@${story.owner.username}`, `Expires ${new Date(story.expiresAt).toLocaleString()}`) + `<div class="story-stage"><img src="${esc(api.image(story.imageUrl))}" alt="${esc(story.text || 'Temporary photo story')}"><div class="story-overlay">${esc(story.sticker)} ${esc(story.text)}</div></div><div class="feature-actions"><button class="btn btn-secondary" data-story-step="-1" ${storyIndex === 0 ? 'disabled':''}>Previous</button><button class="btn btn-secondary" data-story-step="1" ${storyIndex === stories.length-1 ? 'disabled':''}>Next</button>${mine ? `<button class="btn btn-secondary" data-story-viewers="${story._id}">Viewers</button><button class="btn btn-secondary" data-delete-story="${story._id}">Delete story</button>` : `<button class="btn btn-secondary" data-story-react="${story._id}">React ❤️</button><a class="btn btn-secondary" href="/messages.html?user=${story.owner._id}">Reply in Messages</a>`}</div><div id="story-viewers"></div>`;
    }
    if (name === 'nearby') return heading('Places, through other eyes.', 'Explore opt-in, approximate public photo locations. This map never reads your live location.') + `<form id="photo-map-filters" class="feature-search">${select('Category','category',[['','All categories'],...['nature','travel','architecture','portraits','street','food'].map(s => [s,s])])}${input('Published since','since','date')}<button class="btn btn-secondary">Filter map</button></form><div id="photo-map" style="height:450px;border-radius:18px;margin:24px 0"></div><p id="map-note" class="muted small"></p><div id="map-photos"></div>`;
    if (name === 'analytics') {
      const data = await api.get('/analytics/me');
      return heading('Creator studio.', 'Measured interactions, with clear limits.') + `<div class="metric-grid"><div class="metric"><strong>${data.totals.likes}</strong>Current likes</div><div class="metric"><strong>${data.totals.comments}</strong>Comments</div><div class="metric"><strong>${data.followers}</strong>Followers</div></div><p class="muted">${esc(data.definitions)}</p><h2>Most engaged photos</h2>` + photoGrid(data.posts.map(p => ({ ...p, likesCount:p.likes, commentsCount:p.comments, author:user() })));
    }
    if (name === 'notifications') {
      const data = await api.get('/notifications');
      return heading('Your updates.', `${data.unread} unread notifications`) + data.notifications.map(n => `<div class="notice-row"><div><strong>${esc(n.preview || n.type.replaceAll('_',' '))}</strong><p class="muted small">${new Date(n.createdAt).toLocaleString()}</p>${n.conversation ? `<a class="text-link" href="/messages.html?conv=${n.conversation}">Open conversation</a>` : ''}</div>${!n.read ? `<button class="text-link" data-notification-read="${n._id}">Mark read</button>` : '<small>Read</small>'}</div>`).join('') + (!data.notifications.length ? empty('You’re all caught up.') : '');
    }
    if (name === 'settings') {
      const data = await api.get('/settings'); const p = data.privacy || {};
      return heading('Privacy & safety.', 'Choose how you share and who can contact you.') + `<form id="privacy-form" class="feature-form">${select('Account visibility','account',[['public','Public — visible in discovery'],['private','Private — posts visible only to you']],p.account || 'public')}<p class="muted small">Private accounts are owner-only in this release; follower approval is not implemented. Existing photos use access-checked media URLs, but previously downloaded copies cannot be revoked.</p>${select('Who can message me','messages',[['everyone','Everyone'],['following','Only people I follow'],['nobody','Nobody']],p.messages || 'everyone')}${select('Who can call me','calls',[['everyone','Everyone'],['following','Only people I follow'],['nobody','Nobody']],p.calls || 'everyone')}${select('Who can view my stories','stories',[['public','Public'],['followers','Followers']],p.stories || 'public')}${select('Notification preference','notifications',[['true','Enabled'],['false','Muted']],p.notifications === false ? 'false':'true')}${input('Portfolio link (HTTPS)','website','url',`value="${esc(data.website)}" maxlength="200"`)}${input('Photography categories (comma separated)','categories','text',`value="${esc((data.categories || []).join(', '))}" maxlength="320"`)}<button class="btn btn-primary">Save preferences</button></form><h2>Active location sharing</h2>${data.sessions.map(s => `<div class="member-row"><span>Expires ${new Date(s.expiresAt).toLocaleString()}</span><button class="text-link" data-revoke-location="${s._id}">Stop sharing</button></div>`).join('') || empty('You are not sharing live location.')}<h2>Blocked accounts</h2>${data.blocks.map(b => `<div class="member-row"><span>@${esc(b.target?.username || 'deleted account')}</span><button class="text-link" data-unblock-setting="${b.target?._id}">Unblock</button></div>`).join('') || empty('No blocked accounts.')}<div class="feature-actions"><button class="btn btn-secondary" data-feature="reports">Your reports</button>${data.isAdmin ? '<button class="btn btn-secondary" data-feature="moderation">Moderation queue</button>' : ''}<button class="btn btn-secondary" data-delete-request="${data.deletionRequest?.status === 'requested' ? 'cancel':'request'}">${data.deletionRequest?.status === 'requested' ? 'Cancel account deletion request':'Request account deletion'}</button></div><p class="muted small">Deletion is a request for the site owner to review, not immediate erasure. No data is deleted by submitting this request.</p>`;
    }
    if (name === 'moderation') { const data = await api.get('/admin/reports'); const deletion = await api.get('/admin/deletion-requests'); return heading('Moderation queue.', 'Review report reasons and record the outcome. Status changes do not automatically remove content.') + data.reports.map(r => `<div class="notice-row"><div><strong>${esc(r.targetType)} · ${esc(r.target)}</strong><p>${esc(r.reason)}</p><small>${esc(r.status)}</small><div class="feature-actions">${['reviewing','resolved','dismissed'].map(status => `<button class="text-link" data-report-status="${r._id}" data-status="${status}">${status}</button>`).join('')}</div></div></div>`).join('') + '<h2>Account deletion requests</h2><p class="muted small">These requests require a manual data review and deletion process under your retention policy.</p>' + deletion.requests.map(r => `<p>@${esc(r.user?.username)} · ${new Date(r.createdAt).toLocaleString()}</p>`).join(''); }
    if (name === 'reports') { const data = await api.get('/reports'); return heading('Your safety reports.') + data.reports.map(r => `<div class="notice-row"><div><strong>${esc(r.targetType)} · ${esc(r.status)}</strong><p>${esc(r.reason)}</p></div></div>`).join('') + (!data.reports.length ? empty('No reports submitted.') : ''); }
    return heading('Discover') + empty('Choose a section above.');
  }
  async function drawPhotoMap() {
    const filters = $('#photo-map-filters'); const params = filters ? new URLSearchParams([...new FormData(filters)].filter(([,v]) => v)) : new URLSearchParams();
    const data = await api.get('/photo-map?' + params); const element = $('#photo-map'); if (!element) return;
    $('#map-note').textContent = data.precision; $('#map-photos').innerHTML = photoGrid(data.posts);
    if (!window.L) { element.textContent = 'Map library unavailable. You can still browse the photos below.'; return; }
    if (photoMap) photoMap.remove();
    const map = photoMap = L.map(element).setView([20,0],2); L.tileLayer(window.PICSHARE_MAP_TILES || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: window.PICSHARE_MAP_ATTRIBUTION || '© OpenStreetMap contributors' }).addTo(map);
    const points = []; for (const post of data.posts) { const position = [post.publicPlace.lat,post.publicPlace.lng]; points.push(position); const button = document.createElement('button'); button.textContent = post.publicPlace.label || post.caption || 'Open photo'; button.dataset.photo = post._id; button.className = 'text-link'; L.marker(position).addTo(map).bindPopup(button); }
    if (points.length) map.fitBounds(points,{ maxZoom:8,padding:[25,25] });
  }
  function discussionMessages(messages) { return messages.length ? messages.map(m => `<div class="discussion-message"><strong>@${esc(m.author?.username)}</strong><p>${esc(m.text)}</p><small>${new Date(m.createdAt).toLocaleString()}</small></div>`).join('') : empty('Start a conversation with your Circle.'); }
  async function refreshCircle() { if (page.name !== 'space' || !$('#circle-messages')) return; const id = page.id; const data = await api.get(`/spaces/${id}/discussion`); if (page.id === id && $('#circle-messages')) { $('#circle-messages').innerHTML = discussionMessages(data.messages); $('#circle-messages').scrollTop = $('#circle-messages').scrollHeight; } }
  async function refreshBadge() { if (!user()) return; try { const data = await api.get('/conversations'); const count = data.conversations.reduce((n,c) => n + Number(c.unreadCount || 0),0); const badge = $('#msg-badge'); badge.hidden = !count; badge.textContent = count > 99 ? '99+' : count; } catch { /* inbox displays errors on opening */ } }
  async function connectRealtime() {
    if (realtime || !user()) return;
    try {
      if (!window.io) await new Promise((resolve,reject) => { const script = document.createElement('script'); script.src = api.origin + '/socket.io/socket.io.js'; script.onload = resolve; script.onerror = reject; document.head.appendChild(script); });
      if (realtime || !api.token) return;
      realtime = window.io(api.origin,{ auth:{ token:api.token },reconnectionAttempts:10 });
      realtime.on('space:changed',({ spaceId }) => { if (page.name === 'space' && page.id === spaceId) refreshCircle().catch(error); });
      realtime.on('message:new',refreshBadge);
      realtime.on('connect',() => { refreshBadge(); refreshCircle().catch(error); });
    } catch { /* REST and explicit refresh remain available */ }
  }
  async function homeStories() {
    try {
      const data = await api.get('/stories'); stories = data.stories;
      $('#story-list').innerHTML = `<button class="story-button" data-feature="story-create"><span class="story-initial">＋</span><span>Your story</span></button>${stories.map((s,i) => `<button class="story-button" data-story="${i}" aria-label="View story by ${esc(s.owner.username)}">${s.owner.avatarUrl ? `<img src="${esc(api.image(s.owner.avatarUrl))}" alt="">` : `<span class="story-initial">${esc(s.owner.name?.[0] || '?')}</span>`}<span>${esc(s.owner.username)}</span></button>`).join('')}`;
    } catch (err) { $('#story-list').innerHTML = `<button class="text-link" data-retry-stories>Retry stories: ${esc(err.message)}</button>`; }
  }
  async function searchDiscovery(append = false) {
    const form = $('#discover-form'); if (!form) return; const ticket = ++discoveryRequest;
    const params = new URLSearchParams(new FormData(form));
    params.set('category', $('[name="discover-category"]').value); params.set('mood', $('[name="discover-mood"]').value);
    if (append && discoveryCursor) params.set('before', discoveryCursor);
    const grid = $('#discovery-grid'), more = $('#discover-more'); const query = params.get('q');
    more.disabled = true;
    try {
      const data = await api.get(`/discover?${params}`);
      if (page.name !== 'discover' || !grid.isConnected || ticket !== discoveryRequest) return;
      discoveryCursor = data.nextCursor;
      if (append) grid.insertAdjacentHTML('beforeend', photoGrid(data.posts)); else grid.innerHTML = photoGrid(data.posts);
      $('#discovery-explanation').textContent = data.ranking;
      more.hidden = !data.hasMore || params.get('mode') === 'trending';
      if (query && !append) {
        const creators = await api.get(`/users/search?q=${encodeURIComponent(query)}`);
        if ($('#discover-creators')) $('#discover-creators').innerHTML = `<div class="filter-row">${creators.users.map(u => `<button data-profile="${u._id}">@${esc(u.username)}</button>`).join('')}</div>`;
      } else if (!append) $('#discover-creators').innerHTML = '';
      $('#discover-collections').innerHTML = data.collections.map(c => `<button class="resource-card" data-collection="${c._id}"><strong>${esc(c.name)}</strong></button>`).join('') || empty('No matching public collections.');
    } catch (err) { error(err); } finally { if (ticket === discoveryRequest) more.disabled = false; }
  }
  document.addEventListener('input', e => { if (e.target.closest('#circle-message')) delete e.target.closest('form').dataset.retryKey; if (e.target.id === 'discover-search') { clearTimeout(searchTimer); searchTimer = setTimeout(() => searchDiscovery(), 350); } });
  document.addEventListener('change', e => { if (['discover-category','discover-mood','mode'].includes(e.target.name) && page.name === 'discover') searchDiscovery(); });
  document.addEventListener('submit', async e => {
    const form = e.target; const known = ['discover-form','collection-create','challenge-submit','space-create','space-upload','space-invite','item-comment','story-upload','privacy-form','circle-message','photo-map-filters']; if (!known.includes(form.id)) return;
    e.preventDefault(); const button = form.querySelector('button[type="submit"],button:not([type])'); if (button) button.disabled = true;
    const values = Object.fromEntries(new FormData(form));
    try {
      if (form.id === 'photo-map-filters') { await drawPhotoMap(); return; }
      if (form.id === 'discover-form') { await searchDiscovery(); return; }
      if (form.id === 'collection-create') { const data = await api.post('/collections', values); await open('collection', data.collection._id); }
      if (form.id === 'challenge-submit') { await api.post(`/challenges/${page.id}/entries`, values); await open('challenge',page.id); }
      if (form.id === 'space-create') { const data = await api.post('/spaces',values); await open('space',data.space._id); }
      if (form.id === 'circle-message') { const body = { text: values.text, idempotencyKey: form.dataset.retryKey || crypto.randomUUID() }; form.dataset.retryKey = body.idempotencyKey; await api.post(`/spaces/${page.id}/discussion`,body); delete form.dataset.retryKey; form.reset(); await refreshCircle(); }
      if (form.id === 'space-upload') { await api.upload(`/spaces/${page.id}/items`,new FormData(form)); await open('space',page.id); }
      if (form.id === 'space-invite') { await api.post(`/spaces/${page.id}/members`,values); await open('space',page.id); }
      if (form.id === 'item-comment') { const spaceId = page.spaceId, itemId = page.id; await api.post(`/spaces/${spaceId}/items/${itemId}/comments`,values); await openItem(spaceId,itemId); }
      if (form.id === 'story-upload') { await api.upload('/stories',new FormData(form)); await homeStories(); core().navigate('home'); core().toast('Your story is live for 24 hours.'); }
      if (form.id === 'privacy-form') { values.notifications = values.notifications === 'true'; values.categories = String(values.categories || '').split(',').map(s => s.trim()).filter(Boolean); await api.patch('/settings',values); core().toast('Preferences saved.'); await open('settings'); }
    } catch (err) { error(err); } finally { if (button) button.disabled = false; }
  });
  async function openItem(spaceId,itemId) { page = { name:'item',id:itemId,spaceId }; root().hidden = false; mount(await render('item',itemId)); }
  document.addEventListener('click', async e => {
    const b = e.target.closest('button,[data-feature]'); if (!b) return;
    const d = b.dataset;
    try {
      if (d.feature) await open(d.feature);
      if ('retryFeature' in d) { if (page.name === 'item') await openItem(page.spaceId,page.id); else await open(page.name,page.id); }
      if ('retryStories' in d) await homeStories();
      if (d.photo) await open('post',d.photo);
      if (d.collection) await open('collection',d.collection);
      if (d.challenge) await open('challenge',d.challenge);
      if (d.space) await open('space',d.space);
      if (d.tag) { $('#discover-search').value = d.tag; await searchDiscovery(); }
      if (b.id === 'discover-more') await searchDiscovery(true);
      if (d.circleOlder) { b.disabled = true; const data = await api.get(`/spaces/${page.id}/discussion?before=${d.circleOlder}`); $('#circle-messages').insertAdjacentHTML('afterbegin', discussionMessages(data.messages)); if (data.hasMore) { b.dataset.circleOlder = data.nextCursor; b.disabled = false; } else b.remove(); }
      if ('refreshCircle' in d) await refreshCircle();
      if (d.vote) { b.disabled = true; await api.post(`/challenges/${page.id}/vote`,{ entryId:d.vote }); await open('challenge',page.id); }
      if (d.itemComments || d.spaceItem) await openItem(page.id,d.itemComments || d.spaceItem);
      if (d.deleteItem && confirm('Remove this private photo?')) { await api.delete(`/spaces/${page.id}/items/${d.deleteItem}`); await open('space',page.id); }
      if (d.spaceOlder) { b.disabled = true; const data = await api.get(`/spaces/${page.id}?before=${d.spaceOlder}`); root().querySelector('.photo-grid').insertAdjacentHTML('beforeend', data.items.map(item => `<figure class="photo-tile"><img src="${esc(api.image(item.imageUrl))}" alt="${esc(item.caption)}" loading="lazy"><figcaption class="photo-caption"><strong>@${esc(item.author?.username)}</strong><span>${esc(item.caption)}</span><button class="text-link" data-item-comments="${item._id}">Comments</button></figcaption></figure>`).join('')); if (data.hasMore) { b.dataset.spaceOlder = data.nextCursor; b.disabled = false; } else b.remove(); }
      if (d.removeMember && confirm('Revoke this member’s access?')) { await api.delete(`/spaces/${page.id}/members/${d.removeMember}`); await open('space',page.id); }
      if (d.leaveSpace) { await api.delete(`/spaces/${page.id}/members/${user()._id}`); await open('spaces'); }
      if (d.deleteSpace && confirm('Delete this space and its photos? This cannot be undone.')) { await api.delete(`/spaces/${d.deleteSpace}`); await open('spaces'); }
      if (d.removeFromCollection) { await api.post(`/collections/${d.currentCollection}/posts`, { postId:d.removeFromCollection,remove:true }); await open('collection',d.currentCollection); }
      if (d.bookmarksOlder) { b.disabled = true; const data = await api.get(`/bookmarks?before=${d.bookmarksOlder}`); b.insertAdjacentHTML('beforebegin',photoGrid(data.posts)); if (data.hasMore) { b.dataset.bookmarksOlder=data.nextCursor; b.disabled=false; } else b.remove(); }
      if (d.deleteCollection && confirm('Delete this collection? Original posts remain.')) { await api.delete(`/collections/${d.deleteCollection}`); await open('collections'); }
      if ('story' in d) { storyIndex = Number(d.story); await open('story'); }
      if (d.storyStep) { storyIndex += Number(d.storyStep); await open('story'); }
      if (d.storyReact) { await api.post(`/stories/${d.storyReact}/view`,{ reaction:'❤️' }); core().toast('Reaction sent.'); }
      if (d.storyViewers) { const data = await api.get(`/stories/${d.storyViewers}/viewers`); $('#story-viewers').innerHTML = `<h2>${data.count} views</h2>${data.views.map(v => `<p>@${esc(v.viewer?.username)} ${esc(v.reaction)}</p>`).join('')}`; }
      if (d.deleteStory && confirm('Delete your story?')) { await api.delete(`/stories/${d.deleteStory}`); await homeStories(); core().navigate('home'); }
      if (d.notificationRead) { await api.patch(`/notifications/${d.notificationRead}/read`,{}); await open('notifications'); }
      if (d.unblockSetting) { await api.delete(`/users/${d.unblockSetting}/block`); await open('settings'); }
      if (d.revokeLocation) { await api.delete(`/locations/live/${d.revokeLocation}`); await open('settings'); }
      if (d.deleteRequest && confirm(d.deleteRequest === 'cancel' ? 'Cancel your deletion request?' : 'Send an account deletion request to the site owner? No data will be erased immediately.')) { await api.post('/account/deletion-request',{ cancel:d.deleteRequest === 'cancel' }); await open('settings'); }
      if (d.savePost) { const saved = b.textContent.trim() !== 'Saved ✓'; await api.post(`/posts/${d.savePost}/bookmark`,{ saved }); b.textContent = saved ? 'Saved ✓':'Save'; }
      if (d.collectPost) { const data = await api.get('/collections'); if (!data.collections.length) { await open('collections'); core().toast('Create a collection, then return to the photo.'); return; } const name = prompt('Collection name:\n' + data.collections.map(c => c.name).join('\n')); const collection = data.collections.find(c => c.name === name); if (!collection) return; await api.post(`/collections/${collection._id}/posts`,{ postId:d.collectPost }); core().toast('Added to collection.'); }
      if (d.editPost) { const { post } = await api.get(`/posts/${d.editPost}`); const caption = prompt('Edit your caption',post.caption); if (caption === null) return; await api.patch(`/posts/${d.editPost}`,{ caption }); core().toast('Caption updated.'); if (page.name === 'post' && !root().hidden) await open('post',d.editPost); else core().navigate('home'); }
      if (d.reportStatus) { await api.patch(`/admin/reports/${d.reportStatus}`, { status:d.status }); await open('moderation'); }
      if (d.shareProfile) { const url = new URL('/?profile=' + encodeURIComponent(d.shareProfile),window.location.origin).href; try { await navigator.clipboard.writeText(url); core().toast('Profile link copied.'); } catch { prompt('Copy this profile link',url); } }
      if (d.pinPost) { const data = await api.get(`/users/${user()._id}`); const remove = data.user.pinnedPosts?.includes(d.pinPost); await api.post('/profile/pins',{ postId:d.pinPost,remove }); core().toast(remove ? 'Post unpinned.':'Post pinned to your profile.'); }
      if (d.reportUser) { const reason = prompt('Describe the safety concern.'); if (reason) { await api.post('/reports',{ targetType:'user',target:d.reportUser,reason }); core().toast('Report submitted for review.'); } }
      if (d.reportPost) { const reason = prompt('Describe the safety concern (up to 1,000 characters).'); if (reason) { await api.post('/reports',{ targetType:'post',target:d.reportPost,reason }); core().toast('Report submitted for review.'); } }
    } catch (err) { error(err); b.disabled = false; }
  });
  // Updated preferences are retrieved on each visit; no global tracking or location use.
  window.PicShareFeatures = { open, homeStories };
  window.addEventListener('picshare:ready', () => { connectRealtime(); refreshBadge(); });
  window.addEventListener('picshare:logout', () => { realtime?.disconnect(); realtime = null; });
  window.addEventListener('online', () => core()?.toast('You’re back online.'));
  window.addEventListener('offline', () => core()?.toast('You’re offline. Reconnect before sending or uploading.'));
})();
