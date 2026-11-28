import { getShowConfigResolved } from '../utils/runtime-config.js';
import { showCursor, showJson, showPage, showReady } from '../utils/show.js';

export async function onRequestGet({ request, env }) {
  const before = showCursor(request);
  if (Number.isNaN(before)) return showJson({ error: '无效的翻页参数' }, 400);
  try {
    const cfg = await getShowConfigResolved(env);
    const settings = {
      enabled: cfg.enabled !== false,
      style: cfg.style,
      title: cfg.title,
      eyebrow: cfg.eyebrow,
      intro: cfg.intro,
      pageSize: cfg.pageSize,
      showShareButton: cfg.showShareButton !== false,
      showTagFilter: cfg.showTagFilter !== false,
      showCaptions: cfg.showCaptions !== false,
      allowDownload: cfg.allowDownload === true,
    };
    if (!settings.enabled) {
      return showJson({ disabled: true, items: [], next: null, settings });
    }
    if (!await showReady(env)) return showJson({ error: 'Show 暂不可用', settings }, 503);
    const page = await showPage(env, before, false, settings.pageSize);
    return showJson({ ...page, settings });
  } catch (error) {
    console.error('Show list failed:', error);
    return showJson({ error: '暂时无法读取 Show' }, 503);
  }
}
