import type React from 'react';
import { useEffect, useState } from 'react';

export function useDrawerDisclosure(taskId: string) {
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [showAllChecklist, setShowAllChecklist] = useState(false);
  const [showAllSubtasks, setShowAllSubtasks] = useState(false);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  const toggleSection = (key: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const handleAccordionClick = (e: React.MouseEvent<HTMLButtonElement>, key: string) => {
    const isOpening = !openSections.has(key);
    toggleSection(key);
    if (isOpening) {
      const target = e.currentTarget;
      setTimeout(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 150);
    }
  };

  useEffect(() => {
    setShowAllFiles(false);
    setShowAllChecklist(false);
    setShowAllSubtasks(false);
    setOpenSections(new Set());
  }, [taskId]);

  return {
    showAllFiles,
    setShowAllFiles,
    showAllChecklist,
    setShowAllChecklist,
    showAllSubtasks,
    setShowAllSubtasks,
    openSections,
    handleAccordionClick,
  };
}
