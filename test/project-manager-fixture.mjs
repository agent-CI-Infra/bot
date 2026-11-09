import { HttpError } from '../dist/core/security.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Projects } from '../manager/projects.mjs';
import { FakeDocker } from './fake-docker.mjs';

export async function managerFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'project-files-')), docker = new FakeDocker();
  const options = { database: join(root, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' };
  let projects = new Projects(options);
  t.after(async () => { projects.db.close(); await rm(root, { recursive: true, force: true }); });
  const manager = { async call(method, path, input) {
    try {
    const url = new URL('http://manager'+path);
    if (url.pathname === '/v1/projects') return projects.list();
    if (url.pathname === '/v1/defaults') return projects.defaultsView();
    const match = /^\/v1\/projects\/(\d+)(?:\/(\w+)(?:\/([^/]+))?(?:\/(versions|restore))?)?$/.exec(url.pathname);
    if (!match) throw new Error('fixture_manager_route:'+path);
    const [,repo,action,rawName,operation] = match, name = rawName === undefined ? undefined : decodeURIComponent(rawName);
    if (action === 'files') return await projects.files(repo,method,name,operation,input,Object.fromEntries(url.searchParams));
    if (action === 'notes') return await projects.notes(repo,method,name,input);
    if (method === 'GET') return projects.describe(repo);
    if (method === 'PUT') return await projects.register(repo);
    return await projects.operate(repo,action,input);
    } catch(error) { if(typeof error.status==='number') throw new HttpError(error.status,error.message); throw error; }
  } };
  return {root,docker,manager,get projects(){return projects;},restart(){projects.db.close();projects=new Projects(options);}};
}
