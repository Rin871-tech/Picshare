(() => {
  function mount() {
    document.querySelectorAll('[data-contact-tools]').forEach(root => {
      if (root.dataset.mounted) return;
      root.dataset.mounted = 'true'; root.className = 'contact-tools';
      root.innerHTML = `<h3>Find your friends</h3><p>Search by PicShare username, or choose contacts to find friends who opted in. Matching uses email addresses; phone-number-only matching is not available yet. Your address book is not saved.</p><label><input type="checkbox" data-discoverable> Let contacts find my public profile using my email</label><div class="contact-actions"><button class="btn btn-secondary" data-google>Find Google contacts</button><button class="btn btn-secondary" data-device>Choose phone contacts</button></div><p class="contact-status" role="status" aria-live="polite"></p><div class="contact-matches"></div>`;
      const status = root.querySelector('.contact-status');
      const checkbox = root.querySelector('[data-discoverable]');
      PicShareAPI.get('/contacts/preferences').then(data => { checkbox.checked = data.discoverable; }).catch(() => {});
      checkbox.onchange = async () => { checkbox.disabled = true; try { await PicShareAPI.patch('/contacts/preferences', { discoverable: checkbox.checked }); status.textContent = 'Contact discovery preference saved.'; } catch (err) { checkbox.checked = !checkbox.checked; status.textContent = err.message; } finally { checkbox.disabled = false; } };
      function render(data) {
        const list = root.querySelector('.contact-matches'); list.replaceChildren();
        for (const user of data.users || []) {
          const row = document.createElement('div'); row.className = 'contact-match';
          const name = document.createElement('span'); name.textContent = `${user.name} (@${user.username})`;
          const button = document.createElement('button'); button.className = 'btn btn-primary'; button.textContent = 'Message';
          button.onclick = async () => { button.disabled = true; try { const { conversation } = await PicShareAPI.post('/conversations', { recipientId: user._id }); location.href = `/messages.html?conv=${encodeURIComponent(conversation._id)}`; } catch (err) { status.textContent = err.message; button.disabled = false; } };
          row.append(name, button); list.append(row);
        }
        status.textContent = data.users?.length ? `${data.users.length} friends found.${data.truncated ? ' First 500 Google contacts checked.' : ''}` : 'No matches yet. Friends must create a PicShare account and enable contact discovery. You can still search their username.';
      }
      root.querySelector('[data-google]').onclick = async () => {
        if (!confirm('Allow PicShare to read your Google contact email addresses for matching? Addresses and the access token are used temporarily and are not saved.')) return;
        try {
          if (window.PicShareNative) {
            const accessToken = await window.PicShareNative.googleContacts();
            render(await PicShareAPI.post('/contacts/google', { accessToken })); return;
          }
          const config = await PicShareAPI.get('/auth/config');
          if (!window.google?.accounts?.oauth2 || !config.googleClientId) throw new Error('Google Contacts is not ready. Enable the Google People API and configure the OAuth consent screen for Contacts access.');
          const client = google.accounts.oauth2.initTokenClient({ client_id: config.googleClientId, scope: 'https://www.googleapis.com/auth/contacts.readonly', error_callback: () => { status.textContent = 'Google permission was cancelled. Try again.'; }, callback: async response => {
            if (!response.access_token) { status.textContent = 'Google Contacts permission was not granted.'; return; }
            status.textContent = 'Finding friends…';
            try { render(await PicShareAPI.post('/contacts/google', { accessToken: response.access_token })); } catch (err) { status.textContent = err.message; }
          } });
          client.requestAccessToken({ prompt: 'consent' });
        } catch (err) { status.textContent = err.message; }
      };
      root.querySelector('[data-device]').onclick = async () => {
        try {
          let emails;
          if (window.PicShareNative?.pickContacts) emails = await window.PicShareNative.pickContacts();
          else {
            if (!navigator.contacts?.select) throw new Error('Contact selection is not supported in this browser. Use Google Contacts or search by username.');
            const selected = await navigator.contacts.select(['name', 'email'], { multiple: true });
            emails = selected.flatMap(c => c.email || []);
          }
          if (!emails.length) { status.textContent = 'These contacts have no email addresses. Search their PicShare usernames instead.'; return; }
          if (!confirm(`Match ${emails.length} selected email addresses with PicShare? They will be sent to PicShare for this lookup and not saved.`)) return;
          render(await PicShareAPI.post('/contacts/match', { emails: emails.slice(0, 500) }));
        } catch (err) { status.textContent = err.name === 'AbortError' ? 'Contact selection cancelled.' : err.message; }
      };
    });
  }
  window.PicShareContacts = { mount };
})();
