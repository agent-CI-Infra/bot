function sshTargetsCard(project, canManage) {
  const root = card('SSH 远程主机'), listing = element('div'), editor = element('div');
  const status = element('p', '正在读取 SSH 主机…', 'muted');
  status.setAttribute('role', 'status');
  root.append(note('项目电脑里的任务可直接 ssh、scp、rsync 到登记的别名：只有允许角色可用，不可信 PR 默认不可用。每台主机使用一把专用私钥。连通性测试从控制面连接登记地址，核验主机指纹和凭据。'), listing, editor, status);
  const projectPath = '/api/repositories/' + project + '/ssh-targets', poolPath = '/api/ssh-targets';
  let revision = 0;
  const select = (choices, initial) => {
    const control = document.createElement('select');
    for (const [value, label] of choices) control.add(new Option(label, value));
    control.value = initial;
    return control;
  };
  async function act(control, action) {
    control.disabled = true;
    try { await action(); await load(); }
    catch (err) { status.textContent = readErrorText(err); }
    finally { control.disabled = false; }
  }
  function edit(target, path, available) {
    const form = document.createElement('form');
    const alias = input('alias', target?.alias, {required:true});
    const host = input('host', target?.host, {required:true});
    const port = input('port', target?.port ?? 22, {type:'number', min:1, max:65535, required:true});
    const username = input('username', target?.username, {required:true});
    const pin = input('fingerprint', target?.host_key_sha256, {required:true, placeholder:'SHA256:…'});
    const roles = input('roles', target?.allowed_roles.join(', '), {placeholder:'如 dev, qa'});
    const untrusted = checkbox('untrusted', target?.allow_untrusted_pr, '允许不可信 PR 使用此主机');
    const auth = select([['key','专用私钥'],['password','密码']], target?.auth ?? 'key');
    const route = select([['direct','直连'],['proxy_jump','登记的跳板主机'],['tunnel','经控制面隧道']], target?.route ?? 'direct');
    const jump = select([['','请选择'], ...available.filter(row => row.id !== target?.id).map(row => [row.id,row.alias])], target?.jump_id ?? '');
    const jumpField = field('跳板主机',jump);
    const credential = element('div');
    let secret;
    function changeAuth() {
      secret = auth.value === 'key' ? textarea('private_key','',{rows:4,spellcheck:false,autocomplete:'off'}) :
        input('password','',{type:'password',autocomplete:'new-password',minLength:4});
      secret.required = !target || target.auth !== auth.value;
      credential.replaceChildren(field(auth.value === 'key' ? 'SSH 私钥' : 'SSH 密码',secret));
      if (target) credential.append(note('保留原凭据请留空。更换主机、端口、用户、主机指纹或认证方式时需重新填写。'));
    }
    const changeRoute = () => { jumpField.hidden = route.value !== 'proxy_jump'; jump.required = !jumpField.hidden; };
    auth.addEventListener('change',changeAuth); route.addEventListener('change',changeRoute);
    changeAuth(); changeRoute();
    const save = element('button','保存','primary'); save.type = 'submit';
    form.append(element('h4',(target ? '编辑' : '新增') + (path === poolPath ? '全局主机' : '项目主机')),
      field('别名',alias), field('主机地址',host), field('端口',port), field('用户名',username), field('主机公钥指纹',pin),
      field('连接方式',route), jumpField, field('允许角色（逗号分隔）',roles), untrusted, field('认证方式',auth), credential,
      save, button('取消',() => editor.replaceChildren()));
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (save.disabled) return;
      const body = {alias:alias.value,host:host.value,port:Number(port.value),username:username.value,host_key_sha256:pin.value,
        route:route.value,jump_id:route.value === 'proxy_jump' ? jump.value : null,auth:auth.value,
        allowed_roles:roles.value.split(/[\s,，]+/).filter(Boolean),allow_untrusted_pr:untrusted.querySelector('input').checked};
      if (secret.value) body[secret.name] = secret.value;
      void act(save,() => api(path + (target ? '/' + target.id : ''), target ? 'PUT' : 'POST',body));
    });
    editor.replaceChildren(form); alias.focus();
  }
  async function load() {
    const version = ++revision;
    const [projectList, pool] = await Promise.all([api(projectPath), canManage ? api(poolPath) : Promise.resolve({targets:[]})]);
    if (version !== revision) return;
    listing.replaceChildren(); editor.replaceChildren(); status.textContent = '';
    const bound = new Set(projectList.targets.map(target => target.id));
    function group(title, path, rows) {
      listing.append(element('h4', title));
      if (canManage) listing.append(button('新增' + title, () => edit(null,path,rows)));
      if (!rows.length) { listing.append(note('尚未登记主机')); return; }
      const {table,body} = projectTable(['别名','地址','连接方式','操作'], title);
      table.classList.add('ssh-target-table');
      for (const row of rows) {
        const tr = document.createElement('tr'), actions = element('div', '', 'ssh-target-actions');
        tableCell(tr,'别名',element('strong',row.alias));
        tableCell(tr,'地址',element('code',row.username + '@' + row.host + ':' + row.port));
        tableCell(tr,'连接方式',element('span',({direct:'直连',proxy_jump:'跳板',tunnel:'控制面隧道'})[row.route]));
        if (canManage) {
          const test = button('测试连通性', async () => {
            test.disabled = true;
            const result = element('p', '正在测试…', 'muted');
            result.setAttribute('role','status');
            actions.querySelector('[role="status"]')?.remove();
            actions.append(result);
            try {
              const reply = await api(path + '/' + row.id + '/test','POST',{});
              result.textContent = reply.ok ? '认证成功' : '测试失败：' + reply.error;
            } catch (err) { result.textContent = readErrorText(err); }
            finally { test.disabled = false; }
          });
          actions.append(test);
        }
        if (canManage && (row.owner_project || path === poolPath)) {
          actions.append(button('编辑', () => edit(row,path,rows)));
          const remove = button('删除', async () => {
            if (await askConfirm({title:'删除 SSH 主机？',body:[row.alias],action:'删除'}))
              await act(remove,() => api(path + '/' + row.id,'DELETE',{}));
          });
          actions.append(remove);
        }
        if (path === poolPath) {
          const linked = bound.has(row.id);
          const bind = button(linked ? '解除绑定' : '绑定', () =>
            act(bind,() => api(projectPath + '/' + row.id + '/binding',linked ? 'DELETE' : 'PUT',{})));
          actions.append(bind);
        } else if (!row.owner_project) actions.append(element('span','全局绑定'));
        tableCell(tr,'操作',actions); body.append(tr);
      }
      listing.append(table);
    }
    group('项目主机',projectPath,projectList.targets);
    if (canManage) group('全局主机',poolPath,pool.targets);
  }
  load().catch(err => { status.textContent = readErrorText(err); });
  return root;
}
