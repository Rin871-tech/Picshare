(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { user: null, view: 'home', mode: 'all', page: 1, hasMore: false, currentProfileId: null, currentCommentPost: null, searchTimer: null, toastTimer: null, googleClientId: '' };
  const authScreen = $('#auth-screen'), app = $('#app'), authForm = $('#auth-form');

  function esc(value = '') { if (value == null) return ''; return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function initials(user) { const u = user || {}; return (u.name || u.username || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase(); }
  function avatar(user, size = '') { const u = user || {}; const src = PicShareAPI.image(u.avatarUrl); return `<span class="avatar ${size}">${src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : esc(initials(u))}</span>`; }
  function dateLabel(date) { const d = new Date(date), seconds = Math.max(0, (Date.now() - d.getTime()) / 1000); if (!Number.isFinite(d.getTime())) return ''; if (seconds < 60) return 'JUST NOW'; if (seconds < 3600) return `${Math.floor(seconds / 60)} MIN AGO`; if (seconds < 86400) return `${Math.floor(seconds / 3600)} HR AGO`; if (seconds < 604800) return `${Math.floor(seconds / 86400)} DAYS AGO`; return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }).toUpperCase(); }
  function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => el.classList.remove('show'), 2600); }
  function setAuthMode(mode) {
    const register = mode === 'register';
    $$('.auth-tab').forEach(b => b.classList.toggle('active', b.dataset.authMode === mode));
    $('#register-fields').hidden = !register;
    $('#auth-name').required = register;
    $('#auth-username').required = register;
    $('#auth-password').autocomplete = register ? 'new-password' : 'current-password';
    $('#auth-submit').innerHTML = register ? 'Create account <span>→</span>' : 'Log in <span>→</span>';
    const googleBtnText = $('#google-btn-text');
    if (googleBtnText) googleBtnText.textContent = 'Continue with Google';
    $('#auth-error').textContent = '';
  }
  function showAuth() { window.dispatchEvent(new Event('picshare:logout')); authScreen.hidden = false; app.hidden = true; }
  function showApp() {
    authScreen.hidden = true;
    window.PicShareContacts?.mount();
    app.hidden = false;
    window.dispatchEvent(new CustomEvent('picshare:ready', { detail: { user: state.user } }));
    try { renderSidebarUser(); } catch (err) { console.error('Error rendering sidebar user:', err); }
    const profileId = new URLSearchParams(window.location.search).get('profile');
    try { navigate(profileId && /^[a-f0-9]{24}$/.test(profileId) ? 'profile' : 'home', profileId); } catch (err) { console.error('Error navigating home:', err); }
  }
  function renderSidebarUser() { if (!state.user) return; const el = $('#sidebar-user'); if (el) el.innerHTML = `<div class="sidebar-user-row">${avatar(state.user)}<div class="suggestion-info"><strong>${esc(state.user.name || state.user.username)}</strong><span>@${esc(state.user.username)}</span></div></div>`; }

  authForm.addEventListener('input', () => {
    $('#auth-error').textContent = '';
  });

  authForm.addEventListener('submit', async e => {
    e.preventDefault();
    const mode = $('.auth-tab.active')?.dataset.authMode || 'login';
    const button = $('#auth-submit');
    const errorEl = $('#auth-error');
    errorEl.textContent = '';

    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const payload = { email, password };

    if (mode === 'register') {
      const name = $('#auth-name').value.trim();
      const username = $('#auth-username').value.trim().toLowerCase();

      if (!name) {
        errorEl.textContent = 'Please enter your full name.';
        $('#auth-name').focus();
        return;
      }
      if (name.length > 60) {
        errorEl.textContent = 'Full name must be under 60 characters.';
        $('#auth-name').focus();
        return;
      }
      if (!username) {
        errorEl.textContent = 'Please choose a username.';
        $('#auth-username').focus();
        return;
      }
      if (!/^[a-z0-9_.]{3,24}$/.test(username)) {
        errorEl.textContent = 'Username must be 3–24 characters and use only letters, numbers, dots, or underscores.';
        $('#auth-username').focus();
        return;
      }
      payload.name = name;
      payload.username = username;
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errorEl.textContent = 'Please enter a valid email address.';
      $('#auth-email').focus();
      return;
    }

    if (!password || password.length < 8) {
      errorEl.textContent = 'Password must be at least 8 characters long.';
      $('#auth-password').focus();
      return;
    }

    button.disabled = true;
    try {
      const data = await PicShareAPI.post(`/auth/${mode === 'register' ? 'register' : 'login'}`, payload);
      await PicShareAPI.setToken(data.token);
      state.user = data.user;
      showApp();
      toast(mode === 'register' ? 'Welcome to PicShare ✳' : 'Welcome back!');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      button.disabled = false;
    }
  });

  async function handleGoogleCredentialResponse(response) {
    const errorEl = $('#auth-error');
    errorEl.textContent = '';
    if (!response || !response.credential) {
      errorEl.textContent = 'Google sign-in was cancelled or failed. Please try again.';
      return;
    }
    const button = $('#auth-submit');
    if (button) button.disabled = true;
    try {
      const data = await PicShareAPI.post('/auth/google', { credential: response.credential });
      await PicShareAPI.setToken(data.token);
      state.user = data.user;
      showApp();
      toast(`Welcome, ${state.user.name || state.user.username}! ✳`);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function initGoogleAuth() {
    if (window.PicShareNative) {
      $('#google-auth-btn').addEventListener('click', async () => {
        try { await handleGoogleCredentialResponse({ credential: await window.PicShareNative.googleLogin() }); }
        catch (err) { $('#auth-error').textContent = err.message; }
      });
      return;
    }
    try {
      const config = await PicShareAPI.get('/auth/config').catch(() => ({}));
      state.googleClientId = config.googleClientId || '';
    } catch (_) {
      state.googleClientId = '';
    }

    const customBtn = $('#google-auth-btn');
    if (customBtn) {
      customBtn.addEventListener('click', () => {
        const errorEl = $('#auth-error');
        errorEl.textContent = '';
        if (window.PicShareNative) {
          window.PicShareNative.googleLogin().then(credential => handleGoogleCredentialResponse({ credential })).catch(err => { errorEl.textContent = err.message; });
          return;
        }
        if (!state.googleClientId) {
          errorEl.textContent = 'Google Sign-In is not configured yet. Please set GOOGLE_CLIENT_ID in backend/.env.';
          return;
        }
        if (window.google?.accounts?.id) {
          google.accounts.id.prompt(notification => {
            if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
              // If OneTap prompt was not displayed or was dismissed, re-render standard button
              const renderSlot = $('#google-gis-render');
              if (renderSlot) {
                renderSlot.hidden = false;
                $('#google-btn-slot').hidden = true;
              }
            }
          });
        } else {
          errorEl.textContent = 'Google Identity Services library is still loading. Please check your internet connection.';
        }
      });
    }

    function setupGIS() {
      if (!window.google?.accounts?.id || !state.googleClientId) return;
      try {
        google.accounts.id.initialize({
          client_id: state.googleClientId,
          callback: handleGoogleCredentialResponse,
          auto_select: false,
          cancel_on_tap_outside: true,
          itp_support: true
        });
        const gisContainer = $('#google-gis-render');
        if (gisContainer) {
          gisContainer.innerHTML = '';
          google.accounts.id.renderButton(gisContainer, {
            theme: 'outline',
            size: 'large',
            type: 'standard',
            shape: 'rectangular',
            text: 'continue_with',
            logo_alignment: 'left',
            width: 320
          });
          gisContainer.hidden = false;
          $('#google-btn-slot').hidden = true;
        }
      } catch (err) {
        console.warn('GIS setup notice:', err.message);
      }
    }

    // Attempt GIS setup immediately or retry if script is still loading
    if (window.google?.accounts?.id) {
      setupGIS();
    } else {
      let retries = 0;
      const interval = setInterval(() => {
        retries++;
        if (window.google?.accounts?.id) {
          clearInterval(interval);
          setupGIS();
        } else if (retries >= 20) {
          clearInterval(interval);
        }
      }, 250);
    }
  }

  $$('.auth-tab').forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.authMode)));
  window.addEventListener('picshare:unauthorized', () => { PicShareAPI.setToken(null); state.user = null; showAuth(); toast('Please log in again.'); });

  function navigate(view, id = null) {
    $('#feature-view') && ($('#feature-view').hidden = true);
    state.view = view; state.currentProfileId = id || (view === 'profile' ? state.user?._id : null);
    $$('.nav-item[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view || (view === 'profile' && b.dataset.view === 'profile')));
    $('#feed-view').hidden = view !== 'home'; $('#explore-view').hidden = view !== 'explore'; $('#profile-view').hidden = view !== 'profile';
    if (view === 'home') { state.page = 1; loadFeed(true); loadSuggestions(); loadStories(); }
    if (view === 'explore' && window.PicShareFeatures) { window.PicShareFeatures.open('discover'); }
    if (view === 'explore' && !window.PicShareFeatures) { $('#people-search').value = ''; $('#people-results').innerHTML = '<p class="muted">Start typing to find people on PicShare.</p>'; }
    if (view === 'profile') loadProfile(state.currentProfileId);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  document.addEventListener('click', e => {
    const viewButton = e.target.closest('[data-view]'); if (viewButton) { e.preventDefault(); navigate(viewButton.dataset.view); return; }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'create') { openModal('create-modal'); $('#create-error').textContent = ''; return; }
    if (action === 'logout') { PicShareAPI.setToken(null); state.user = null; showAuth(); setAuthMode('login'); toast('You have logged out.'); return; }
    const close = e.target.closest('[data-close]'); if (close) closeModal(close.dataset.close);
    const mode = e.target.closest('[data-mode]'); if (mode) { state.mode = mode.dataset.mode; $$('.feed-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === state.mode)); state.page = 1; loadFeed(true); }
    const follow = e.target.closest('[data-follow]'); if (follow) toggleFollow(follow.dataset.follow, follow);
    const profile = e.target.closest('[data-profile]'); if (profile) navigate('profile', profile.dataset.profile);
    const like = e.target.closest('[data-like]'); if (like) toggleLike(like.dataset.like, like);
    const comments = e.target.closest('[data-comments]'); if (comments) openComments(comments.dataset.comments);
    const delPost = e.target.closest('[data-delete-post]'); if (delPost) deletePost(delPost.dataset.deletePost);
    const delComment = e.target.closest('[data-delete-comment]'); if (delComment) deleteComment(delComment.dataset.deleteComment, delComment.dataset.postId);
    const block = e.target.closest('[data-block]'); if (block && confirm('Block this account? This stops messages, calls, and live sharing.')) PicShareAPI.post(`/users/${block.dataset.block}/block`, {}).then(() => toast('Account blocked.')).catch(err => toast(err.message));
    const unblock = e.target.closest('[data-unblock]'); if (unblock) PicShareAPI.delete(`/users/${unblock.dataset.unblock}/block`).then(() => toast('Account unblocked.')).catch(err => toast(err.message));
    const share = e.target.closest('[data-share-post]'); if (share) sharePost(share.dataset.sharePost);
    const editProfile = e.target.closest('[data-edit-profile]'); if (editProfile) editProfileForm();
  });
  function openModal(id) { const modal = $(`#${id}`); modal.hidden = false; document.body.style.overflow = 'hidden'; }
  function closeModal(id) { const modal = $(`#${id}`); if (modal) modal.hidden = true; if ($$('.modal-backdrop:not([hidden])').length === 0) document.body.style.overflow = ''; }
  $$('.modal-backdrop').forEach(backdrop => backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(backdrop.id); }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal-backdrop:not([hidden])').forEach(m => closeModal(m.id)); });

  const coreViewChanged = () => state.view !== 'home';
  let feedLoading = false, feedEpoch = 0;
  let sharedPostId = new URLSearchParams(window.location.search).get('post');
  async function loadFeed(replace = false) {
    if (feedLoading && !replace) return;
    const epoch = replace ? ++feedEpoch : feedEpoch; feedLoading = true; $('#load-more').disabled = true;
    const list = $('#feed-list'); if (replace) list.innerHTML = '<div class="loading-card">Finding your moments<span class="loading-dots"> ···</span></div>';
    $('#load-more').hidden = true;
    try {
      let data;
      if (sharedPostId && replace) { const result = await PicShareAPI.get(`/posts/${encodeURIComponent(sharedPostId)}`); data = { posts: [result.post], hasMore: false }; sharedPostId = null; }
      else data = await PicShareAPI.get(`/posts/feed?mode=${state.mode}&page=${state.page}&limit=12`);
      if (epoch !== feedEpoch || coreViewChanged()) return;
      if (replace) list.innerHTML = '';
      if (!data.posts.length && replace) list.innerHTML = `<div class="empty-state"><strong>No moments just yet.</strong><br>${state.mode === 'following' ? 'Follow some people or switch to For you.' : 'Be the first to share something with your circle.'}<br><button class="btn btn-primary" data-action="create" style="margin-top:15px">Create a post</button></div>`;
      data.posts.forEach(post => { if (!list.querySelector(`[data-post-card="${CSS.escape(post._id)}"]`)) list.insertAdjacentHTML('beforeend', postCard(post)); });
      state.hasMore = data.hasMore; $('#load-more').hidden = !data.hasMore;
      $('#feed-title').textContent = state.mode === 'following' ? 'Your people.' : 'The little things.';
    } catch (err) { if (replace && epoch === feedEpoch) list.innerHTML = `<div class="empty-state">${esc(err.message)}<br><button class="btn btn-secondary" data-action="retry-feed">Try again</button></div>`; } finally { if (epoch === feedEpoch) { feedLoading = false; $('#load-more').disabled = false; } }
  }
  $('#load-more').addEventListener('click', () => { state.page += 1; loadFeed(false); });
  document.addEventListener('click', e => { if (e.target.closest('[data-action="retry-feed"]')) loadFeed(true); });
  function postCard(post) {
    const author = post.author || {}; const image = PicShareAPI.image(post.imageUrl); const liked = Boolean(post.isLiked); const mine = String(author._id) === String(state.user?._id);
    return `<article class="post-card" data-post-card="${esc(post._id)}"><header class="post-head">${avatar(author)}<div class="post-author"><strong data-profile="${esc(author._id)}">${esc(author.username || 'member')}</strong><span>${esc(dateLabel(post.createdAt))}</span></div>${mine ? `<button class="post-menu-delete" data-delete-post="${esc(post._id)}" aria-label="Delete post">Delete</button>` : '<span class="post-menu" aria-hidden="true">···</span>'}</header><div class="post-image-wrap"><img class="post-image" src="${esc(image)}" alt="${esc(post.altText || `Photo shared by ${author.username || 'a member'}`)}" loading="lazy"></div><div class="post-actions"><button class="action-button ${liked ? 'liked' : ''}" data-like="${esc(post._id)}" aria-label="${liked ? 'Unlike' : 'Like'} post">${liked ? '♥' : '♡'} <span>${Number(post.likesCount || post.likes?.length || 0)}</span></button><button class="action-button" data-comments="${esc(post._id)}" aria-label="View comments">◯ <span>${Number(post.commentsCount || 0)}</span></button><button class="action-button save-action" data-share-post="${esc(post._id)}" aria-label="Share post in a message">↗</button></div>${post.likesCount || post.likes?.length ? `<div class="post-likes">${Number(post.likesCount ?? post.likes.length)} ${Number(post.likesCount ?? post.likes.length) === 1 ? 'like' : 'likes'}</div>` : ''}${post.caption ? `<div class="post-caption"><strong data-profile="${esc(author._id)}">${esc(author.username || 'member')}</strong>${esc(post.caption).replace(/\n/g, '<br>')}</div>` : ''}<button class="post-comments-link" data-comments="${esc(post._id)}">${post.commentsCount ? `View all ${post.commentsCount} comments` : 'Be the first to comment'}</button><div class="post-time">${esc(dateLabel(post.createdAt))}</div><div class="post-extra"><button class="text-link" data-save-post="${esc(post._id)}">${post.isBookmarked ? 'Saved ✓' : 'Save'}</button><button class="text-link" data-collect-post="${esc(post._id)}">Collect</button><button class="text-link" data-report-post="${esc(post._id)}">Report</button>${mine ? `<button class="text-link" data-edit-post="${esc(post._id)}">Edit caption</button><button class="text-link" data-pin-post="${esc(post._id)}">Pin / unpin</button>` : ''}</div></article>`;
  }
  async function toggleLike(id, button) {
    button.disabled = true;
    try { const data = await PicShareAPI.post(`/posts/${id}/like`, {}); const card = button.closest('[data-post-card]'); if (!card) return; const b = $('[data-like]', card); b.classList.toggle('liked', data.liked); b.innerHTML = `${data.liked ? '♥' : '♡'} <span>${data.likesCount}</span>`; b.setAttribute('aria-label', data.liked ? 'Unlike post' : 'Like post'); let likes = $('.post-likes', card); if (data.likesCount > 0) { if (!likes) { likes = document.createElement('div'); likes.className = 'post-likes'; $('.post-actions', card).after(likes); } likes.textContent = `${data.likesCount} ${data.likesCount === 1 ? 'like' : 'likes'}`; } else if (likes) likes.remove(); }
    catch (err) { toast(err.message); } finally { button.disabled = false; }
  }
  async function deletePost(id) { if (!confirm('Delete this post? This cannot be undone.')) return; try { await PicShareAPI.delete(`/posts/${id}`); $$(`[data-post-card="${CSS.escape(id)}"]`).forEach(card => card.remove()); toast('Post deleted.'); if (state.view === 'profile') loadProfile(state.currentProfileId); } catch (err) { toast(err.message); } }
  async function loadStories() { if (window.PicShareFeatures) await window.PicShareFeatures.homeStories(); }
  async function loadSuggestions() {
    const el = $('#suggestion-list'); try { const data = await PicShareAPI.get('/users/search?q=a'); const users = (data.users || []).filter(u => !u.isMe && !u.isFollowing).slice(0, 4); if (!users.length) { el.innerHTML = '<p class="muted small">You are all caught up. Explore to find more people.</p>'; return; } el.innerHTML = users.map(u => `<div class="suggestion-row">${avatar(u, 'avatar-sm')}<div class="suggestion-info"><strong data-profile="${esc(u._id)}">${esc(u.username)}</strong><span>${esc(u.name)}</span></div><button class="follow-mini" data-follow="${esc(u._id)}">Follow</button></div>`).join(''); } catch (_) { el.innerHTML = '<p class="muted small">Explore to find people to follow.</p>'; }
  }
  async function toggleFollow(id, button) {
    button.disabled = true; try { const data = await PicShareAPI.post(`/users/${id}/follow`, {}); button.textContent = data.following ? 'Following' : 'Follow'; button.classList.toggle('btn-secondary', data.following); if (state.view === 'profile' && state.currentProfileId === id) loadProfile(id); else loadSuggestions(); toast(data.following ? 'You are following this person.' : 'You unfollowed this person.'); }
    catch (err) { toast(err.message); } finally { button.disabled = false; }
  }
  let searchTimer;
  $('#people-search').addEventListener('input', () => { clearTimeout(searchTimer); const q = $('#people-search').value.trim(); if (!q) { $('#people-results').innerHTML = '<p class="muted">Start typing to find people on PicShare.</p>'; return; } $('#people-results').innerHTML = '<p class="muted">Looking around…</p>'; searchTimer = setTimeout(() => searchPeople(q), 280); });
  $('#people-search').addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); searchPeople($('#people-search').value.trim()); } });
  async function searchPeople(q) { if (!q) return; try { const data = await PicShareAPI.get(`/users/search?q=${encodeURIComponent(q)}`); const users = data.users || []; $('#people-results').innerHTML = users.length ? users.map(u => `<article class="person-card">${avatar(u, 'avatar-lg')}<div class="person-details"><strong data-profile="${esc(u._id)}">${esc(u.name)}</strong><span>@${esc(u.username)} · ${Number(u.followersCount || 0)} followers</span></div>${u.isMe ? '<span class="muted small">You</span>' : `<button class="btn ${u.isFollowing ? 'btn-secondary' : 'btn-primary'}" data-follow="${esc(u._id)}">${u.isFollowing ? 'Following' : 'Follow'}</button>`}</article>`).join('') : '<div class="empty-state">No people found. Try another name.</div>'; } catch (err) { $('#people-results').innerHTML = `<p class="form-error">${esc(err.message)}</p>`; } }

  async function loadProfile(id) {
    const root = $('#profile-content'); root.innerHTML = '<div class="loading-card">Opening profile<span class="loading-dots"> ···</span></div>';
    try { let data; if (!id || String(id) === String(state.user?._id)) { data = await PicShareAPI.get('/users/me'); const profile = await PicShareAPI.get(`/users/${data.user._id}`); data = { ...profile, stats: profile.stats }; } else data = await PicShareAPI.get(`/users/${id}`);
      const u = data.user; const isMe = data.isMe || String(u._id) === String(state.user?._id); const stats = data.stats || {}; const posts = data.posts || [];
      root.innerHTML = `<div class="profile-header"><div class="profile-avatar-wrap">${avatar(u, 'avatar-lg')}</div><div class="profile-details"><div class="profile-title-row"><h1>${esc(u.username)}</h1>${isMe ? '<button class="btn btn-secondary" data-edit-profile>Edit profile</button>' : `<button class="btn ${data.isFollowing ? 'btn-secondary' : 'btn-primary'}" data-follow="${esc(u._id)}">${data.isFollowing ? 'Following' : 'Follow'}</button>`}</div>${!isMe ? `<a class="btn btn-secondary" href="/messages.html?user=${esc(u._id)}">Message</a><button class="text-link" data-block="${esc(u._id)}">Block</button><button class="text-link" data-unblock="${esc(u._id)}">Unblock</button>` : ''}<div class="profile-stats"><span><strong>${Number(stats.postsCount || posts.length)}</strong> posts</span><span><strong>${Number(stats.followersCount || 0)}</strong> followers</span><span><strong>${Number(stats.followingCount || 0)}</strong> following</span></div><p class="profile-name">${esc(u.name)}</p>${stats.questCount ? `<p class="muted small">Photo Quest participant · ${Number(stats.questCount)} entries</p>` : ''}${u.categories?.length ? `<p class="muted small">${esc(u.categories.join(' · '))}</p>` : ''}<div class="profile-bio">${esc(u.bio || (isMe ? 'Your bio is a little empty. Add a few words about yourself.' : 'A PicShare member.'))}</div></div></div><div class="feature-actions"><button class="btn btn-secondary" data-share-profile="${esc(u._id)}">Share profile</button>${isMe ? '<button class="btn btn-secondary" data-feature="analytics">Creator studio</button><button class="btn btn-secondary" data-feature="settings">Privacy &amp; safety</button><button class="btn btn-secondary" data-feature="collections">My collections</button>' : `<button class="text-link" data-report-user="${esc(u._id)}">Report account</button>`}${u.website ? `<a class="text-link" href="${esc(u.website)}" target="_blank" rel="noopener noreferrer">Portfolio ↗</a>` : ''}</div><div class="profile-tabs"><button class="profile-tab active">▦ POSTS</button><button class="profile-tab" data-view="explore">⌕ DISCOVER</button></div>${posts.length ? `<div class="profile-grid">${posts.map(p => `<div class="profile-grid-item" data-comments="${esc(p._id)}"><img src="${esc(PicShareAPI.image(p.imageUrl))}" alt="Post by ${esc(u.username)}" loading="lazy"><div class="grid-meta">♥ ${Number(p.likesCount || 0)}　◯ ${Number(p.commentsCount || 0)}</div></div>`).join('')}</div>` : `<div class="profile-empty"><strong>${isMe ? 'Your story starts here.' : 'No posts yet.'}</strong><span>${isMe ? 'Share your first moment with your people.' : 'This person has not shared a moment yet.'}</span>${isMe ? '<br><button class="btn btn-primary" data-action="create">Create your first post ↗</button>' : ''}</div>`}`;
    } catch (err) { root.innerHTML = `<div class="empty-state">${esc(err.message)}<br><button class="btn btn-secondary" data-view="home">Back to home</button></div>`; }
  }
  function editProfileForm() {
    if (!state.user) return;
    const root = $('#profile-content'); const u = state.user;
    root.insertAdjacentHTML('afterbegin', `<div class="edit-profile-panel" style="background:#fff;border:1px solid var(--line);border-radius:15px;padding:18px;margin-bottom:20px"><form id="edit-profile-form"><h3 style="margin:0 0 12px">Edit your profile</h3><label for="edit-name">Name</label><input id="edit-name" maxlength="60" required value="${esc(u.name)}" style="display:block;width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;margin:6px 0 12px"><label for="edit-username">Username</label><input id="edit-username" maxlength="24" required value="${esc(u.username)}" style="display:block;width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;margin:6px 0 12px"><label for="edit-bio">Bio</label><textarea id="edit-bio" maxlength="160" rows="3" style="display:block;width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;margin:6px 0 12px">${esc(u.bio || '')}</textarea><label for="avatar-file">Profile photo</label><input id="avatar-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif" style="display:block;margin:8px 0 14px"><p id="edit-profile-error" class="form-error"></p><div style="display:flex;gap:8px"><button class="btn btn-primary" type="submit">Save changes</button><button class="btn btn-secondary" type="button" id="cancel-edit-profile">Cancel</button></div></form></div>`);
    $('#cancel-edit-profile').addEventListener('click', () => $('.edit-profile-panel')?.remove());
    $('#edit-profile-form').addEventListener('submit', async e => { e.preventDefault(); const error = $('#edit-profile-error'); try { const data = await PicShareAPI.patch('/users/me', { name: $('#edit-name').value.trim(), username: $('#edit-username').value.trim(), bio: $('#edit-bio').value }); state.user = { ...state.user, ...data.user }; const file = $('#avatar-file').files[0]; if (file) { const fd = new FormData(); fd.append('image', file); const avatarData = await PicShareAPI.upload('/users/me/avatar', fd); state.user = { ...state.user, ...avatarData.user }; } renderSidebarUser(); toast('Profile updated.'); loadProfile(state.user._id); } catch (err) { error.textContent = err.message; } });
  }

  async function sharePost(postId) {
    const username = prompt('Send this post to which PicShare username?');
    if (!username) return;
    try {
      const data = await PicShareAPI.get(`/users/search?q=${encodeURIComponent(username.trim().replace(/^@/, ''))}`);
      const recipient = data.users.find(u => u.username === username.trim().replace(/^@/, '').toLowerCase());
      if (!recipient) { toast('No account found with that username.'); return; }
      const { conversation } = await PicShareAPI.post('/conversations', { recipientId: recipient._id });
      await PicShareAPI.post(`/conversations/${conversation._id}/messages`, { type: 'post_share', postRef: postId, text: 'Shared a photo', idempotencyKey: crypto.randomUUID() });
      window.location.href = `/messages.html?conv=${conversation._id}`;
    } catch (err) { toast(err.message); }
  }
  async function openComments(postId) {
    state.currentCommentPost = postId; $('#comments-list').innerHTML = '<p class="muted">Loading the conversation…</p>'; $('#comment-input').value = ''; $('#comment-error').textContent = ''; openModal('comments-modal');
    try { const data = await PicShareAPI.get(`/posts/${postId}/comments`); renderComments(data.comments || []); } catch (err) { $('#comments-list').innerHTML = `<p class="form-error">${esc(err.message)}</p>`; }
  }
  function renderComments(comments) { const el = $('#comments-list'); if (!comments.length) { el.innerHTML = '<div class="empty-state">A little kindness goes a long way.<br>Start the conversation.</div>'; return; } el.innerHTML = comments.map(c => `<div class="comment-row">${avatar(c.author, 'avatar-sm')}<div class="comment-body"><strong data-profile="${esc(c.author?._id)}">${esc(c.author?.username || 'member')}</strong>${esc(c.text)}<time>${esc(dateLabel(c.createdAt))}</time></div>${String(c.author?._id) === String(state.user?._id) ? `<button class="comment-delete" data-delete-comment="${esc(c._id)}" data-post-id="${esc(state.currentCommentPost)}" aria-label="Delete comment">×</button>` : ''}</div>`).join(''); }
  $('#comment-form').addEventListener('submit', async e => { e.preventDefault(); const input = $('#comment-input'); const text = input.value.trim(); if (!text || !state.currentCommentPost) return; const button = $('button[type="submit"]', e.currentTarget); button.disabled = true; $('#comment-error').textContent = ''; try { const data = await PicShareAPI.post(`/posts/${state.currentCommentPost}/comments`, { text }); input.value = ''; const existing = $$(`[data-post-card="${CSS.escape(state.currentCommentPost)}"]`).find(card => !card.closest('[hidden]')); if (existing) { const countButton = $('[data-comments]', existing); const count = Number(countButton.textContent.match(/\d+/)?.[0] || 0) + 1; countButton.textContent = `View all ${count} comments`; } const loaded = await PicShareAPI.get(`/posts/${state.currentCommentPost}/comments`); renderComments(loaded.comments || []); $('#comments-list').scrollTop = $('#comments-list').scrollHeight; } catch (err) { $('#comment-error').textContent = err.message; } finally { button.disabled = false; } });
  async function deleteComment(commentId, postId) { if (!confirm('Delete this comment?')) return; try { await PicShareAPI.delete(`/posts/${postId}/comments/${commentId}`); const data = await PicShareAPI.get(`/posts/${postId}/comments`); renderComments(data.comments || []); const card = $$(`[data-post-card="${CSS.escape(postId)}"]`).find(card => !card.closest('[hidden]')); if (card) { const countButton = $('[data-comments]', card); countButton.textContent = data.comments.length ? `View all ${data.comments.length} comments` : 'Be the first to comment'; } toast('Comment deleted.'); } catch (err) { toast(err.message); } }

  const postImage = $('#post-image'); postImage.addEventListener('change', () => { const file = postImage.files[0]; $('#create-error').textContent = ''; if (!file) return; if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024) { $('#create-error').textContent = 'Choose a JPEG, PNG, WEBP, or GIF image up to 5 MB.'; postImage.value = ''; return; } const preview = $('#image-preview'); preview.src = URL.createObjectURL(file); preview.hidden = false; $('#upload-label').textContent = file.name; });
  $('#apply-ai').addEventListener('click', () => { $('#post-caption').value = $('#ai-caption-preview').value; $('#post-alt').value = $('#ai-alt-preview').value; $('#post-caption').dispatchEvent(new Event('input')); $('#ai-preview').hidden = true; $('#ai-status').textContent = 'Suggestions applied. Review your post and share when ready.'; });
  $('#suggest-caption').addEventListener('click', async () => {
    const image = postImage.files[0];
    if (!image) { $('#ai-status').textContent = 'Choose a photo first.'; return; }
    if (!confirm('Send this selected photo and caption context to the configured AI provider for suggestions?')) return;
    const button = $('#suggest-caption'); button.disabled = true; $('#ai-status').textContent = 'Preparing suggestions…';
    const fd = new FormData(); fd.append('image', image); fd.append('context', $('#post-caption').value.slice(0, 1000));
    try {
      const result = await PicShareAPI.upload('/ai/suggest', fd);
      $('#ai-caption-preview').value = [result.caption, result.hashtags.join(' ')].filter(Boolean).join('\n\n').slice(0, 2200);
      $('#ai-alt-preview').value = result.altText;
      $('#ai-topics').textContent = [result.categories?.length ? 'Topics: ' + result.categories.join(', ') : '', result.mood ? 'Mood: ' + result.mood : ''].filter(Boolean).join(' · ');
      $('#ai-preview').hidden = false;
      $('#ai-status').textContent = 'Review and edit suggestions, then choose Apply. Nothing has been published.';
    } catch (err) { $('#ai-status').textContent = err.message; }
    finally { button.disabled = false; }
  });
  $('#post-caption').addEventListener('input', () => { $('#caption-count').textContent = `${$('#post-caption').value.length.toLocaleString()} / 2,200`; });
  $('#create-form').addEventListener('submit', async e => { e.preventDefault(); const file = postImage.files[0]; const error = $('#create-error'); if (!file) { error.textContent = 'Choose a photo before sharing.'; return; } const button = $('#create-submit'); button.disabled = true; error.textContent = ''; const fd = new FormData(); fd.append('image', file); fd.append('caption', $('#post-caption').value.trim()); fd.append('altText', $('#post-alt').value.trim()); fd.append('category', $('#post-category').value); fd.append('mood', $('#post-mood').value); if ($('#share-place').checked) { fd.append('sharePlace','true'); fd.append('placeLat',$('#place-lat').value); fd.append('placeLng',$('#place-lng').value); fd.append('placeLabel',$('#place-label').value); } try { await PicShareAPI.upload('/posts', fd); closeModal('create-modal'); $('#create-form').reset(); $('#image-preview').hidden = true; $('#upload-label').textContent = 'Choose a photo'; $('#caption-count').textContent = '0 / 2,200'; toast('Your moment is out in the world ✳'); if (state.view === 'home') { state.page = 1; loadFeed(true); } else navigate('home'); } catch (err) { error.textContent = err.message; } finally { button.disabled = false; } });

  async function boot() {
    try { await PicShareAPI.ready; } catch { document.body.innerHTML = '<main><h1>Unable to open secure session storage</h1><p>Restart PicShare and try again.</p></main>'; return; }
    setAuthMode(new URLSearchParams(location.search).get("auth") === "login" ? "login" : "register");
    initGoogleAuth();
    if (!PicShareAPI.token) { showAuth(); return; }
    try {
      const data = await PicShareAPI.get('/users/me');
      state.user = data.user;
      showApp();
    } catch (err) {
      if (err.status === 401) await PicShareAPI.setToken(null);
      showAuth();
      if (err.status !== 401) { $('#auth-error').textContent = 'Unable to reconnect. Your account is saved. Check your connection and reload.'; }
      else setAuthMode('login');
    }
  }
  window.PicShareCore = { state, navigate, postCard, toast, loadStories };
  boot();
})();
