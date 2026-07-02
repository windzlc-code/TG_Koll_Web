(() => {
  const keys = Object.keys(window).filter((k) => /nuxt|api|workflow|playground|detail/i.test(k));
  const payload = {};
  for (const key of keys.slice(0, 80)) {
    try {
      const value = window[key];
      if (value && typeof value === 'object') {
        payload[key] = Array.isArray(value) ? { type: 'array', length: value.length } : { type: 'object', keys: Object.keys(value).slice(0, 40) };
      } else {
        payload[key] = { type: typeof value, value: String(value).slice(0, 200) };
      }
    } catch (e) {
      payload[key] = { error: String(e) };
    }
  }
  return payload;
})()