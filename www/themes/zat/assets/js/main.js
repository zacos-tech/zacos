// Theme and CRT switcher
(function() {
  const themes = ['amber', 'green', 'blue', 'purple', 'red', 'silver'];

  // Get saved preferences
  const savedTheme = localStorage.getItem('zat-theme') || 'silver';
  const savedCrt = localStorage.getItem('zat-crt') === 'on';

  // Apply saved preferences immediately
  document.documentElement.setAttribute('data-theme', savedTheme);
  if (savedCrt) {
    document.documentElement.setAttribute('data-crt', 'on');
    document.documentElement.setAttribute('data-glow', 'heavy');
  } else {
    document.documentElement.removeAttribute('data-crt');
    document.documentElement.removeAttribute('data-glow');
  }

  function createControls() {
    const controls = document.createElement('div');
    controls.className = 'site-controls';

    // CRT toggle
    const crtToggle = document.createElement('button');
    crtToggle.className = 'crt-toggle' + (savedCrt ? ' active' : '');
    crtToggle.setAttribute('title', 'Toggle CRT Effects');
    crtToggle.textContent = 'CRT';

    crtToggle.addEventListener('click', () => {
      const isOn = document.documentElement.hasAttribute('data-crt');
      if (isOn) {
        document.documentElement.removeAttribute('data-crt');
        document.documentElement.removeAttribute('data-glow');
        localStorage.setItem('zat-crt', 'off');
        crtToggle.classList.remove('active');
      } else {
        document.documentElement.setAttribute('data-crt', 'on');
        document.documentElement.setAttribute('data-glow', 'heavy');
        localStorage.setItem('zat-crt', 'on');
        crtToggle.classList.add('active');
      }
    });

    // Theme switcher
    const switcher = document.createElement('div');
    switcher.className = 'theme-switcher';

    themes.forEach(theme => {
      const btn = document.createElement('button');
      btn.className = 'theme-btn';
      btn.setAttribute('data-theme-btn', theme);
      btn.setAttribute('title', theme.charAt(0).toUpperCase() + theme.slice(1));
      if (theme === savedTheme) btn.classList.add('active');

      btn.addEventListener('click', () => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('zat-theme', theme);
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });

      switcher.appendChild(btn);
    });

    controls.appendChild(switcher);
    controls.appendChild(crtToggle);

    // Add to header
    const header = document.querySelector('.site-header .container');
    if (header) {
      header.appendChild(controls);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createControls);
  } else {
    createControls();
  }
})();
