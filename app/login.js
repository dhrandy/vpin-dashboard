let setupRequired = false;
const $ = id => document.getElementById(id);
(async () => {
  try {
    if(!window.isSecureContext){$('message').textContent='HTTPS is required. Do not enter credentials on this connection.';$('submit').disabled=true;return;}
    const state = await fetch('/api/auth/status').then(r=>r.json());
    if (state.user) { location.replace('/'); return; }
    setupRequired = state.setupRequired;
    $('setup').hidden = !setupRequired;
    $('password-note').hidden = !setupRequired;
    $('setup-token').required = setupRequired;
    $('password').minLength = setupRequired ? 12 : 1;
    $('password').autocomplete = setupRequired ? 'new-password' : 'current-password';
    $('heading').textContent = setupRequired ? 'Create your admin' : 'Sign in';
    $('submit').textContent = setupRequired ? 'Create admin account' : 'Sign in';
    $('intro').textContent = setupRequired ? 'Secure the dashboard before anyone can browse it.' : 'A private view of the pinball cabinet.';
  } catch { $('message').textContent = 'The server could not be reached. Reload to try again.'; }
})();
$('login-form').addEventListener('submit', async e => {
  e.preventDefault(); if(!window.isSecureContext){$('message').textContent='Open this dashboard over HTTPS before entering a password.';return;} $('submit').disabled = true; $('message').textContent = '';
  try {
    const r = await fetch(setupRequired ? '/api/auth/setup' : '/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Vpin-Request':'1'},body:JSON.stringify({username:$('username').value,password:$('password').value,setupToken:$('setup-token').value})});
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Sign in failed.');
    const state = await fetch('/api/auth/status').then(r=>r.json());
    if (!state.user) throw new Error('The secure session cookie was not accepted. Open this dashboard over HTTPS.');
    $('password').value = ''; $('setup-token').value = ''; location.replace('/');
  } catch(e) { $('message').textContent = e.message; }
  finally { $('submit').disabled = false; }
});
