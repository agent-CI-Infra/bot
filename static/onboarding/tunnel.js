// The tunnel token field, also used by global settings: the server keeps only the token found in what is pasted.
function tunnelCredential(placeholder){
  const credential=input('token','',{type:'password',autocomplete:'new-password',maxLength:131072,placeholder});
  credential.addEventListener('paste',event=>{
    const pasted=event.clipboardData?.getData('text/plain');if(!pasted||!/[\r\n]/.test(pasted))return;
    // Password inputs strip newlines; preserve word boundaries when pasting multi-line instructions.
    event.preventDefault();const start=credential.selectionStart,end=credential.selectionEnd,room=credential.maxLength-credential.value.length+end-start;
    credential.setRangeText(pasted.replace(/\\\r?\n/g,'').replace(/[\r\n]+/g,' ').slice(0,Math.max(0,room)),start,end,'end');
  });
  return credential;
}
