export function initTheme() {
  const themeToggleBtn = document.getElementById('theme-toggle');
  function applyTheme(theme) {
    const html = document.documentElement;
    html.classList.add('transitioning');
    if (theme === 'light') {
      html.classList.add('light');
      themeToggleBtn.textContent = '\u263E'; // moon
      themeToggleBtn.title = 'Switch to dark';
    } else {
      html.classList.remove('light');
      themeToggleBtn.textContent = '\u2600'; // sun
      themeToggleBtn.title = 'Switch to light';
    }
    localStorage.setItem('pixelTheme', theme);
    setTimeout(() => html.classList.remove('transitioning'), 550);
  }
  themeToggleBtn.addEventListener('click', () => {
    const isLight = document.documentElement.classList.contains('light');
    applyTheme(isLight ? 'dark' : 'light');
  });
  applyTheme(localStorage.getItem('pixelTheme') || 'dark');
}
