titles.onboarding='接入向导';
let onboardingStep=0;
// Null until step 1 is drawn, which then picks Cloudflare Tunnel when a tunnel token is saved; leaving step 1 resets it.
let onboardingTunnel=null;
const onboardingSteps=['公网 HTTPS','GitHub App','GitHub 登录','安装','模型','规则','完成'];
$('logout').addEventListener('click',()=>{$('onboarding-panel')?.replaceChildren();onboardingStep=0;onboardingTunnel=null;if(onboardingAddress.test(location.hash))history.replaceState(null,'','#/settings/onboarding/0');});
