(() => {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState();
  if (saved) window.scrollTo(0, saved.scrollY || 0);
  document.getElementById('more')?.addEventListener('click', () => vscode.postMessage({ type: 'more' }));
  window.addEventListener('scroll', () => vscode.setState({ scrollY: window.scrollY }));
})();
