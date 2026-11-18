export async function login(page, f, hash, username = 'administrator', password = f.password) {
  await page.goto(f.h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
