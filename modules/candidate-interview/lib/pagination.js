export function buildListPageRange(currentPage, totalPages, windowSize = 5) {
  const total = Math.max(0, Number(totalPages) || 0);
  const current = Math.min(Math.max(1, Number(currentPage) || 1), Math.max(1, total));
  if (total <= 1) {
    return {
      pages: total === 1 ? [1] : [],
      showFirst: false,
      showLast: false,
      showFirstEllipsis: false,
      showLastEllipsis: false,
    };
  }
  let start = Math.max(1, current - Math.floor(windowSize / 2));
  let end = Math.min(total, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);
  const pages = [];
  for (let i = start; i <= end; i += 1) pages.push(i);
  return {
    pages,
    showFirst: start > 1,
    showLast: end < total,
    showFirstEllipsis: start > 2,
    showLastEllipsis: end < total - 1,
  };
}

export function parseListPagination(query, defaultLimit = 25, maxLimit = 100) {
  const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || defaultLimit), maxLimit);
  let page = parseInt(query.page, 10) || 1;
  if (page < 1) page = 1;
  return { page, limit, offset: (page - 1) * limit };
}
