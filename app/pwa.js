/* Install support only. No private data is persisted on the phone here. */
(() => {
  let installPrompt=null;
  const button=document.getElementById('install-app');
  const note=document.getElementById('install-note');
  const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  const update=()=>{
    button.hidden=!installPrompt||standalone();
    note.textContent=standalone()?'Installed. Internet access and sign-in are still required.':'Android: use Install app when offered, or your browser menu. iPhone/iPad: open in Safari, tap Share, then Add to Home Screen. Requires HTTPS. This app does not save cabinet or account data for offline use.';
  };
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;update();});
  button.addEventListener('click',async()=>{
    if(!installPrompt)return;
    const prompt=installPrompt;installPrompt=null;update();
    try{await prompt.prompt();await prompt.userChoice;}catch{note.textContent='Use your browser menu to install, or Safari Share > Add to Home Screen.';}
  });
  window.addEventListener('appinstalled',()=>{installPrompt=null;update();});
  if('serviceWorker' in navigator&&window.isSecureContext){navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).catch(()=>{note.textContent='Install support is unavailable in this browser. Try its Add to Home Screen menu. HTTPS is required.';});}
  update();
})();
