import { useEffect, useState } from 'react';

export type AppTheme = 'light' | 'dark';

export function useAppTheme() {
  const [theme, setTheme] = useState<AppTheme>(() => {
    const saved = localStorage.getItem('devflow_theme');
    if (saved === 'light' || saved === 'dark') return saved;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  });

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('devflow_theme', theme);
  }, [theme]);

  return { theme, setTheme };
}
