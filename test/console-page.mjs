import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Loads console scripts from static/ into a sandbox with a small stand-in DOM: enough to load the scripts and draw
// lists, so page logic can be tested without a browser. Selectors support tags, #id, .class, [attr], [attr=value], descendant and
// `:scope >` steps.
class FakeElement {
  constructor(tagName) {
    Object.assign(this, { tagName: tagName.toUpperCase(), id: '', className: '', textContent: '', hidden: false, children: [], parentElement: null,
      dataset: {}, attributes: {}, listeners: {}, style: {} });
    const names = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      contains: name => names().includes(name),
      add: (...add) => { this.className = [...new Set([...names(), ...add])].join(' '); },
      remove: (...remove) => { this.className = names().filter(name => !remove.includes(name)).join(' '); },
      toggle: (name, force = !names().includes(name)) => { force ? this.classList.add(name) : this.classList.remove(name); return force; },
    };
  }
  get childElementCount() { return this.children.length; }
  get lastElementChild() { return this.children.at(-1) || null; }
  setAttribute(name, value) { if (name.startsWith('data-')) this.dataset[camel(name)] = String(value); else this.attributes[name] = String(value); }
  getAttribute(name) { return (name.startsWith('data-') ? this.dataset[camel(name)] : this.attributes[name]) ?? null; }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) { if (name.startsWith('data-')) delete this.dataset[camel(name)]; else delete this.attributes[name]; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? Object.assign(new FakeElement('#text'), { textContent: node }) : node;
      child.remove(); child.parentElement = this; this.children.push(child);
    }
  }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  replaceWith(...nodes) {
    const parent = this.parentElement; if (!parent) return;
    for (const node of nodes) node.remove();
    parent.children.splice(parent.children.indexOf(this), 1, ...nodes); nodes.forEach(node => { node.parentElement = parent; }); this.parentElement = null;
  }
  // Dialogs open and close as in a browser, except that `close` is dispatched at once.
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; for (const listener of this.listeners.close || []) listener({ type: 'close' }); }
  focus() { this.ownerFocus = true; }
  scrollIntoView() {}
  remove() { if (this.parentElement) { this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; } }
  querySelectorAll(selector) { return select(this, selector); }
  querySelector(selector) { return select(this, selector)[0] || null; }
}
const camel = name => name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase());
function simple(element, part) {
  const [, tag, id, classes, attributes] = /^(\w+)?(?:#([\w-]+))?((?:\.[\w-]+)*)((?:\[[\w-]+(?:=[\w-]+)?\])*)$/.exec(part) || [];
  if (classes === undefined) throw new Error('unsupported selector: ' + part);
  return (!tag || element.tagName === tag.toUpperCase()) && (!id || element.id === id)
    && classes.split('.').filter(Boolean).every(name => element.classList.contains(name))
    && [...attributes.matchAll(/\[([\w-]+)(?:=([\w-]+))?\]/g)].every(([, name, value]) => element.hasAttribute(name) && (value === undefined || element.getAttribute(name) === value));
}
function select(root, selector) {
  const parts = selector.trim().split(/\s+/), found = [];
  // Matched right to left; a step before `>` must be the parent, any other step some ancestor below the root.
  const fits = (element, index) => {
    if (!simple(element, parts[index])) return false;
    if (index === 0) return true;
    if (parts[index - 1] === '>') return parts[index - 2] === ':scope' ? element.parentElement === root : !!element.parentElement && fits(element.parentElement, index - 2);
    for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) if (fits(parent, index - 1)) return true;
    return false;
  };
  const walk = node => { for (const child of node.children) { if (fits(child, parts.length - 1)) found.push(child); walk(child); } };
  walk(root); return found;
}

/** `respond(method, path, body)` returns `[status, json]`; every request is recorded in `requests` as "METHOD path". */
export function loadConsole(files, respond) {
  const root = new FakeElement('html'), byId = new Map(), requests = [];
  const document = {
    body: new FakeElement('body'), createElement: tag => new FakeElement(tag), addEventListener() {},
    // Elements the scripts look up by id hang under one root, so document-wide selectors such as `#rows .row` find them.
    getElementById(id) { if (!byId.has(id)) { const element = Object.assign(new FakeElement('div'), { id }); root.append(element); byId.set(id, element); } return byId.get(id); },
    querySelectorAll: selector => select(root, selector), querySelector: selector => select(root, selector)[0] || null,
  };
  const fetch = async (path, init = {}) => {
    const method = init.method || 'GET'; requests.push(`${method} ${path}`);
    const [status, value] = await respond(method, path, init.body && JSON.parse(init.body));
    return { ok: status < 400, status, json: async () => value };
  };
  const context = vm.createContext({ document, Node: FakeElement, fetch, location: { hash: '', pathname: '/' }, history: { pushState() {} }, addEventListener() {},
    setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout, URL, URLSearchParams, console });
  context.window = context;
  for (const file of files) vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
  return { requests, $: id => document.getElementById(id), run: code => vm.runInContext(code, context) };
}
