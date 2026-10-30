// No localStorage, cookies, tracking pixels or arbitrary referral URLs.
(async () => {
  const form = document.querySelector('#interest-form');
  const status = document.querySelector('#intake-status');
  const errors = document.querySelector('#form-errors');
  const submit = document.querySelector('#submit-interest');
  const outcome = form.elements.outcome;
  const page = document.querySelector('[data-intake-page]').dataset.intakePage;
  const query = new URLSearchParams(location.search);
  const selected = query.get('outcome');
  const known = [...outcome.options].map(option => option.value);
  outcome.value = known.includes(selected) ? selected : page === 'feedback' ? 'feedback' : page === 'advisory' ? 'educator-council' : 'demo';
  const source = ['demo', 'teachers', 'district'].includes(query.get('source')) ? query.get('source') : page;
  let challenge = '', widget, busy = false;
  let idempotencyKey = crypto.randomUUID();
  const sync = () => { submit.disabled = busy || !challenge; };
  const syncPrivacy = () => {
    const privacy = outcome.value === 'deletion';
    if (privacy) form.elements.marketingOptIn.checked = false;
    form.elements.marketingOptIn.disabled = privacy;
  };
  outcome.addEventListener('change', syncPrivacy);
  syncPrivacy();
  let config;
  try {
    const response = await fetch('/api/interest/config', {credentials: 'omit', cache: 'no-store', redirect: 'error'});
    if (!response.ok) return;
    config = await response.json();
    if (!/^0x[A-Za-z0-9_-]{10,100}$/.test(config.siteKey)) return;
  } catch { return; }
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.referrerPolicy = 'no-referrer';
  script.addEventListener('load', () => {
    form.hidden = false;
    status.textContent = 'Choose a request. Ongoing updates are optional.';
    widget = window.turnstile.render('#turnstile', {
      sitekey: config.siteKey, action: 'interest',
      callback: token => { challenge = token; sync(); },
      'expired-callback': () => { challenge = ''; sync(); },
      'error-callback': () => { challenge = ''; sync(); status.textContent = 'The security check could not load. Please try again later or email hello@educateos.io.'; },
    });
  }, {once: true});
  script.addEventListener('error', () => { status.textContent = 'The security check could not load. Please try later or email hello@educateos.io.'; }, {once: true});
  document.head.append(script);
  // Native constraint validation focuses invalid fields before the submit event fires.
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !challenge || !form.reportValidity()) return;
    busy = true; sync(); errors.textContent = '';
    const data = new FormData(form);
    const record = Object.fromEntries(['name', 'workEmail', 'org', 'state', 'role', 'blocker', 'systems', 'limitedFeedback', 'honeypot'].map(key => [key, data.get(key) ?? '']));
    record.limitedFeedback = record.limitedFeedback.replace(/\s+/g, ' ').trim();
    const councilType = outcome.value === 'educator-council' ? 'educator' : outcome.value === 'technical-council' ? 'technical' : '';
    Object.assign(record, {
      interestType: councilType ? 'council' : outcome.value, councilType,
      marketingOptIn: data.has('marketingOptIn'), responseConsent: data.has('responseConsent'),
      staffConfirmed: data.has('staffConfirmed'), privacyAcknowledged: data.has('privacyAcknowledged'),
      referralSource: source, consentVersion: config.consentVersion, turnstileToken: challenge, idempotencyKey,
    });
    try {
      const response = await fetch('/api/interest', {
        method: 'POST', credentials: 'omit', redirect: 'error',
        headers: {'Content-Type': 'application/json', 'X-Interest-Request': '1'}, body: JSON.stringify(record),
      });
      if (!response.ok) {
        errors.textContent = response.status === 429 ? 'Too many requests. Please wait 10 minutes before trying again.' : response.status === 409 ? 'This retry changed a previously submitted request. Reload the page to start a new request.' : response.status === 400 ? 'Check your entries: use professional details, omit links and sensitive information, and complete a fresh security check.' : 'Intake is unavailable. Please try later or email hello@educateos.io.';
        errors.focus();
      } else {
        form.reset(); syncPrivacy(); form.hidden = true;
        status.textContent = 'Your request was received for review. Details remain unverified. This did not send an email or enroll you in a pilot.';
        status.focus(); idempotencyKey = crypto.randomUUID();
      }
    } catch { errors.textContent = 'We could not confirm receipt. Retry the same details after the security check refreshes.'; errors.focus(); }
    finally { busy = false; challenge = ''; window.turnstile.reset(widget); sync(); }
  });
})();
