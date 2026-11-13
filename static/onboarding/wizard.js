function wizardForm(title,fields,submit,save){
  const section=card(title),form=element('form','','project-form'),message=element('p','','view-error');message.setAttribute('role','alert');
  const action=element('button',submit);action.type='submit';form.append(...fields,message,action);section.append(form);
  form.onsubmit=async event=>{event.preventDefault();action.disabled=true;message.textContent='';try{if(await save(Object.fromEntries(new FormData(form)),form)!==false)await render();}catch(error){message.textContent=error.message;}finally{action.disabled=false;}};return section;
}
function wizardDetails(title,...nodes){
  const details=element('details','','fold');details.append(element('summary',title),...nodes);return details;
}
// The step lives in the address (#/settings/onboarding/<index>) so a reload stays on it. replaceState adds no history entry and
// fires no hashchange; the caller draws the step.
function wizardStep(step){history.replaceState(null,'','#/settings/onboarding/'+step);}
function wizardNext(step){wizardStep(step);void render().catch(error);}
// #/settings/onboarding/<0-6> names a step; #/settings/onboarding or an unknown step is the first. Without a wizard address (the tab
// button, the first login) the wizard stays on its current step.
function addressedStep(){
  if(!/^#\/settings\/onboarding(?:\/|$)/.test(location.hash))return onboardingStep;
  return Number(onboardingAddress.exec(location.hash)?.[1]||0);
}
