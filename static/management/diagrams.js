// Mermaid flow diagrams inside rendered Markdown (#1123): management answers, knowledge notes and the Manager and role
// prompt reading views. The source is untrusted model or user text, so:
// - the console CSP is not relaxed for it: Mermaid draws in an offscreen host of this page, where inline script and
//   inline style stay blocked (Mermaid's own <style> and style attributes are refused there and simply not applied);
// - Mermaid parses with securityLevel 'strict' and plain SVG text labels, and a %%{init}%% directive in the source may
//   not change those, the theme or the size limits (`secure`);
// - the SVG is cleaned by DOMPurify's SVG profile before it reaches the page, without <style>, foreignObject, images
//   or any style/href attribute, and links (`click` lines) become plain groups, so nothing in a diagram navigates and
//   its colours and type come only from diagrams.css and the shared tokens.
// The library (about 2.8 MB) is fetched on the first diagram. A block that cannot be drawn keeps its source on screen.
const diagramCache = new Map(), diagramStale = new WeakSet(), DIAGRAM_CACHE_SIZE = 32;
let diagramLibrary = null, diagramQueue = Promise.resolve(), diagramSerial = 0, diagramHost = null;
const diagramSanitize = {
  USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true, ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['style', 'foreignObject', 'image', 'use', 'script'], FORBID_ATTR: ['style', 'href', 'xlink:href']
};

function loadDiagramLibrary() {
  diagramLibrary ??= new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/vendor/mermaid.js';
    script.addEventListener('load', () => { try { resolve(configureDiagramLibrary(window.mermaid)); } catch (err) { reject(err); } });
    script.addEventListener('error', () => { script.remove(); reject(new Error('diagram_library_unavailable')); });
    document.head.append(script);
  }).catch(err => { diagramLibrary = null; throw err; });
  return diagramLibrary;
}
function configureDiagramLibrary(library) {
  // Mermaid sizes boxes from the text it measures, so it measures with the console's own family and size.
  const root = getComputedStyle(document.documentElement), font = root.fontFamily, size = root.getPropertyValue('--font-size-2').trim() || '14px';
  library.initialize({
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, maxTextSize: 20000, maxEdges: 300,
    htmlLabels: false, flowchart: { htmlLabels: false }, look: 'classic', theme: 'base', fontFamily: font, themeVariables: { fontFamily: font, fontSize: size },
    secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges', 'htmlLabels', 'flowchart', 'look', 'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'darkMode']
  });
  return library;
}

// Called on a sanitized Markdown fragment: each ```mermaid block becomes a figure that keeps its source in a fold.
function mountDiagrams(fragment) {
  for (const code of fragment.querySelectorAll('pre > code.language-mermaid')) code.parentElement.replaceWith(diagramFigure(code.textContent.replace(/\n$/, '')));
}
// The Markdown under `node` is about to be replaced; its figures will never be shown, so their queued drawing is skipped.
function retireDiagrams(node) {
  for (const figure of node.querySelectorAll('figure.diagram')) diagramStale.add(figure);
}
function diagramFigure(source) {
  const figure = element('figure', '', 'diagram'), status = element('p', '', 'diagram-status muted');
  const fold = element('details', '', 'diagram-source'), pre = element('pre');
  pre.append(element('code', source)); fold.append(element('summary', '流程图源码'), pre);
  figure.append(status, fold);
  const cached = diagramCache.get(source);
  if (cached) showDiagram(figure, cached);
  else { figure.dataset.diagram = 'pending'; status.textContent = '正在绘制流程图…'; queueDiagram(figure, source); }
  return figure;
}
function queueDiagram(figure, source) {
  // A streaming answer redraws its Markdown every frame. The short wait lets a block settle before Mermaid parses it;
  // figures replaced in the meantime are stale and skipped. Drawing is serial: Mermaid shares one measuring host.
  setTimeout(() => {
    diagramQueue = diagramQueue.then(async () => {
      if (diagramStale.has(figure)) return;
      const result = diagramCache.get(source) ?? await drawDiagramSource(source);
      if (!result.retry) {
        diagramCache.delete(source); diagramCache.set(source, result);
        if (diagramCache.size > DIAGRAM_CACHE_SIZE) diagramCache.delete(diagramCache.keys().next().value);
      }
      if (!diagramStale.has(figure)) showDiagram(figure, result);
    }).catch(() => {});
  }, 200);
}
async function drawDiagramSource(source) {
  let library;
  try { library = await loadDiagramLibrary(); } catch { return { error: 'unavailable', retry: true }; }
  if (!diagramHost?.isConnected) { diagramHost = element('div', '', 'diagram-measure'); diagramHost.setAttribute('aria-hidden', 'true'); document.body.append(diagramHost); }
  try { return { svg: (await library.render('diagram-' + ++diagramSerial, source, diagramHost)).svg }; }
  catch { return { error: 'syntax' }; }
  finally { diagramHost.replaceChildren(); }
}
function showDiagram(figure, result) {
  const status = figure.querySelector('.diagram-status'), fold = figure.querySelector('.diagram-source');
  const svg = result.svg ? DOMPurify.sanitize(result.svg, diagramSanitize).querySelector('svg') : null;
  if (!svg) {
    figure.dataset.diagram = 'failed'; fold.open = true;
    status.textContent = result.error === 'unavailable' ? '流程图组件没有加载成功，下面是源码。' : '这段流程图语法有误或超出大小限制，没有绘制，下面是源码。';
    return;
  }
  // A cached drawing can be shown twice (an answer and a prompt, a reading view and its preview). Each copy gets its own
  // ids, so its arrowheads (url(#…)) and title never resolve into another copy that may be hidden.
  const suffix = '-' + ++diagramSerial, ids = new Map();
  for (const el of [svg, ...svg.querySelectorAll('[id]')]) if (el.id) { ids.set(el.id, el.id + suffix); el.id += suffix; }
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (attr.value.includes('url(#')) attr.value = attr.value.replace(/url\(#([^)]+)\)/g, (whole, id) => ids.has(id) ? `url(#${ids.get(id)})` : whole);
      else if (attr.name.startsWith('aria-') && attr.name.endsWith('by')) attr.value = attr.value.split(/\s+/).map(id => ids.get(id) ?? id).join(' ');
    }
  }
  // Mermaid places a clickable node by the transform of the <a> around it; keep the place, drop the link.
  for (const link of svg.querySelectorAll('a')) {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g'), place = link.getAttribute('transform');
    if (place) group.setAttribute('transform', place);
    group.append(...link.childNodes); link.replaceWith(group);
  }
  // The SVG scales with the column down to 70% of its drawn size; a wider chart scrolls inside its own frame instead
  // of widening the page. Sizes go through CSSOM, which the CSP allows, never through a style attribute.
  const width = svg.viewBox.baseVal?.width || 0;
  svg.removeAttribute('width'); svg.removeAttribute('height');
  if (width) { svg.style.maxWidth = width + 'px'; svg.style.minWidth = Math.round(width * 0.7) + 'px'; }
  const title = svg.querySelector('title')?.textContent.trim();
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', title || '流程图');
  const canvas = element('div', '', 'diagram-canvas'); canvas.tabIndex = 0;
  canvas.setAttribute('role', 'region'); canvas.setAttribute('aria-label', '流程图，可横向滚动'); canvas.append(svg);
  figure.dataset.diagram = 'ready'; status.textContent = ''; status.hidden = true;
  figure.querySelector('.diagram-canvas')?.remove(); figure.prepend(canvas);
}
