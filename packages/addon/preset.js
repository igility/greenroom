module.exports = {
  managerEntries: (entries = []) => [...entries, require.resolve('./dist/manager.mjs')],
  previewAnnotations: (entries = []) => [...entries, require.resolve('./dist/preview.mjs')],
};
