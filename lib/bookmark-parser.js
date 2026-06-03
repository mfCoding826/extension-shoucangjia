/**
 * bookmark-parser.js — Chrome 书签 HTML 文件解析器
 *
 * 解析 Chrome 导出的 Netscape Bookmark HTML 格式文件。
 * 格式参考：https://docs.microsoft.com/en-us/previous-versions/windows/internet-explorer/ie-developer/platform-apis/aa753582(v=vs.85)
 *
 * 输入示例：
 * <!DOCTYPE NETSCAPE-Bookmark-file-1>
 * <META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
 * <TITLE>Bookmarks</TITLE>
 * <H1>Bookmarks</H1>
 * <DL><p>
 *   <DT><A HREF="https://example.com" ADD_DATE="1234567890">Example</A>
 *   <DT><H3>文件夹名称</H3>
 *   <DL><p>
 *     <DT><A HREF="https://nested.com">Nested Page</A>
 *   </DL><p>
 * </DL><p>
 */

/**
 * 解析 Chrome 书签 HTML 文件，提取所有书签（不含文件夹）
 * @param {string} html - 书签文件的完整 HTML 内容
 * @returns {Array<{title: string, url: string, folder: string}>}
 */
function parseBookmarkFile(html) {
  const bookmarks = [];

  // 使用正则提取所有 <A> 标签（书签）+ 跟踪当前文件夹层级
  const linkRegex = /<A\s[^>]*HREF="([^"]*)"[^>]*>([^<]*)<\/A>/gi;
  const folderRegex = /<DT>\s*<H3[^>]*>([^<]*)<\/H3>/gi;

  // 先提取所有文件夹位置
  const folders = [];
  let folderMatch;
  while ((folderMatch = folderRegex.exec(html)) !== null) {
    folders.push({
      index: folderMatch.index,
      name: folderMatch[1].trim()
    });
  }

  // 提取所有书签
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const rawUrl = linkMatch[1];
    const rawTitle = linkMatch[2].trim();

    // 跳过无效 URL（如 javascript:、place: 等）
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
      continue;
    }

    // 跳过无标题的占位书签
    if (!rawTitle) {
      continue;
    }

    // 确定所属文件夹：找到当前书签位置之前最近的一个文件夹
    let folder = '根目录';
    for (let i = folders.length - 1; i >= 0; i--) {
      if (folders[i].index < linkMatch.index) {
        folder = folders[i].name;
        break;
      }
    }

    bookmarks.push({
      title: htmlDecode(rawTitle),
      url: rawUrl,
      folder
    });
  }

  return bookmarks;
}

/**
 * HTML 实体解码
 */
function htmlDecode(str) {
  const textarea = (typeof document !== 'undefined')
    ? document.createElement('textarea')
    : null;

  if (textarea) {
    textarea.innerHTML = str;
    return textarea.value;
  }

  // Service Worker 中没有 DOM，使用正则替换
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
