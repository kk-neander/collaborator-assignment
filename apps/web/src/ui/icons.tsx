import type { ReactNode, SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

function Svg(props: P & { children: ReactNode }) {
  const { children, ...rest } = props;
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const IconFile = (p: P) => (<Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></Svg>);
export const IconFolder = (p: P) => (<Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>);
export const IconFolderOpen = (p: P) => (<Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1" /><path d="M3 7v10a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L21.5 12a1.5 1.5 0 0 0-1.4-2H8.2a2 2 0 0 0-1.9 1.4L3.5 19" /></Svg>);
export const IconChevron = (p: P) => (<Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>);
export const IconFilePlus = (p: P) => (<Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M12 11v6M9 14h6" /></Svg>);
export const IconFolderPlus = (p: P) => (<Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 10v6M9 13h6" /></Svg>);
export const IconPencil = (p: P) => (<Svg {...p}><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></Svg>);
export const IconTrash = (p: P) => (<Svg {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></Svg>);
export const IconMove = (p: P) => (<Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /><path d="M5 5v14" /></Svg>);
export const IconLink = (p: P) => (<Svg {...p}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Svg>);
export const IconCheck = (p: P) => (<Svg {...p}><path d="m5 12 5 5 9-10" /></Svg>);
export const IconX = (p: P) => (<Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>);
export const IconAlert = (p: P) => (<Svg {...p}><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17.5v.5" /></Svg>);
export const IconInfo = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.5" /></Svg>);
export const IconPlay = (p: P) => (<Svg {...p}><path d="M7 5v14l11-7z" /></Svg>);
export const IconSun = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>);
export const IconMoon = (p: P) => (<Svg {...p}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></Svg>);
export const IconSparkle = (p: P) => (<Svg {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" /></Svg>);
export const IconReload = (p: P) => (<Svg {...p}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></Svg>);
export const IconExternal = (p: P) => (<Svg {...p}><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Svg>);
export const IconScissors = (p: P) => (<Svg {...p}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" /></Svg>);
export const IconSnail = (p: P) => (<Svg {...p}><path d="M3 18h14a4 4 0 0 0 4-4V9" /><circle cx="11" cy="12" r="5" /><path d="M11 12a2 2 0 1 0 2-2M19 9l-1-4M21 9l1-4" /></Svg>);
export const IconPlug = (p: P) => (<Svg {...p}><path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v5" /><path d="M3 3l18 18" /></Svg>);
export const IconClock = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>);
export const IconLogout = (p: P) => (<Svg {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3" /></Svg>);
export const IconSend = (p: P) => (<Svg {...p}><path d="M4 12 20 4l-6 16-3-7z" /><path d="m11 13 9-9" /></Svg>);
export const IconBrain = (p: P) => (<Svg {...p}><path d="M11 4a3 3 0 0 0-5.6 1.5A3 3 0 0 0 3.5 10 3 3 0 0 0 4 15.5 3 3 0 0 0 8 19.5a3 3 0 0 0 3 .5z" /><path d="M13 4a3 3 0 0 1 5.6 1.5A3 3 0 0 1 20.5 10a3 3 0 0 1-.5 5.5 3 3 0 0 1-4 4 3 3 0 0 1-3 .5z" /></Svg>);
export const IconUndo = (p: P) => (<Svg {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></Svg>);
export const IconRedo = (p: P) => (<Svg {...p}><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></Svg>);
