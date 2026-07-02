(() => {
  const nuxt = window.__NUXT__ || {};
  const seen = [];
  const walk = (value, path, depth = 0) => {
    if (depth > 5) return;
    if (value == null) return;
    const text = JSON.stringify(value);
    if (/1900814586436534274|nodeInfoList|fieldName|fieldValue|api-detail|workflow|taskId/i.test(text)) {
      seen.push({ path, preview: text.slice(0, 1500) });
    }
    if (Array.isArray(value)) {
      value.slice(0, 20).forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      Object.keys(value).slice(0, 40).forEach((key) => walk(value[key], `${path}.${key}`, depth + 1));
    }
  };
  walk(nuxt, '__NUXT__');
  return seen;
})()