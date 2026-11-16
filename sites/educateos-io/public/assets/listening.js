// Responses stay in this page's memory until submission. No browser persistence or analytics.
(async () => {
  const form = document.querySelector('form[data-kind]');
  const fields = document.querySelector('#fields');
  const status = document.querySelector('#availability');
  const errors = document.querySelector('#errors');
  const result = document.querySelector('#result');
  const button = form.querySelector('button');
  const kind = form.dataset.kind;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const receipt = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  let challenge = '', widget, busy = false, submitted = false;
  const sync = () => { button.disabled = !challenge || busy; };
  let config;
  try {
    const response = await fetch('/api/listening/config', {credentials: 'omit', cache: 'no-store', redirect: 'error'});
    if (!response.ok) return;
    config = await response.json();
  } catch { return; }
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.addEventListener('load', () => {
    widget = window.turnstile.render('#challenge', {
      sitekey: config.siteKey, action: 'listening',
      callback: token => { challenge = token; sync(); },
      'expired-callback': () => { challenge = ''; sync(); },
      'error-callback': () => { challenge = ''; sync(); status.textContent = 'The security check could not finish. Please reload or try later.'; },
    });
    fields.disabled = false;
    status.textContent = 'Collection is open. Complete the security check to send your response.';
  }, {once: true});
  script.addEventListener('error', () => { status.textContent = 'The security check could not load. Please try later. Nothing has been submitted.'; }, {once: true});
  document.head.append(script);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || submitted || !challenge || !form.reportValidity()) return;
    const data = new FormData(form);
    const record = {adult: data.has('adult'), participation: data.has('participation'), noticeVersion: config.noticeVersion,
      receipt, turnstileToken: challenge, honeypot: data.get('honeypot')};
    if (kind === 'survey') for (const field of ['roles', 'tools', 'workflows', 'policy', 'interests', 'barriers']) record[field] = data.getAll(field);
    else Object.assign(record, {email: data.get('email'), topic: data.get('topic'), followUpConsent: data.has('followUpConsent')});
    busy = true; errors.textContent = ''; sync();
    try {
      const response = await fetch('/api/listening/' + kind, {method: 'POST', credentials: 'omit', redirect: 'error',
        headers: {'Content-Type': 'application/json', 'X-Listening-Request': '1'}, body: JSON.stringify(record)});
      if (!response.ok) {
        errors.textContent = response.status === 429 ? 'Too many attempts. Please wait 10 minutes before trying again.' : response.status === 409 ? 'This retry changed an earlier submission. Reload the page to send a new response.' : response.status === 400 ? 'Check the form and complete a fresh security check. Nothing new was accepted.' : 'Collection is unavailable. Your response was not confirmed. Please try later.';
        errors.focus();
      } else {
        submitted = true; form.reset(); form.hidden = true;
        result.textContent = kind === 'survey' ? 'Thank you — your response was received. Save this deletion code before leaving this page: ' + receipt + '. To request removal, email hello@educateos.io with this code. Your survey did not register you for follow-up.' : 'Thank you — your follow-up request was received. This did not subscribe you to marketing. Email hello@educateos.io to withdraw permission or request deletion.';
        status.textContent = 'Submission received.'; result.focus();
      }
    } catch {
      errors.textContent = 'We could not confirm receipt. Keep this page open and retry the same answers with a fresh security check. For survey deletion, save this code: ' + receipt;
      errors.focus();
    } finally {
      busy = false; challenge = ''; if (!submitted) window.turnstile.reset(widget); sync();
    }
  });
})();
