import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

export function renderMarkdown(element, text) {
  element.classList.add('markdown');
  element.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks:true, gfm:true, async:false }), {
    ALLOWED_TAGS: ['p','br','strong','em','del','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','pre','code','hr','table','thead','tbody','tr','th','td','a'],
    ALLOWED_ATTR: ['href','title','start'],
    ALLOW_DATA_ATTR: false,
  });
  for (const link of element.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    if (!/^(https?:|mailto:)/i.test(href)) link.removeAttribute('href');
    else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  }
  for (const pre of element.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const button = document.createElement('button');
    button.textContent = '复制'; button.className = 'copy-code';
    button.onclick = async () => {
      try { await navigator.clipboard.writeText(code.textContent); button.textContent = '已复制'; }
      catch { button.textContent = '复制失败'; }
    };
    pre.append(button);
  }
}
