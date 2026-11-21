import React from 'react';

interface AppLogoProps {
  className?: string;
}

/**
 * Quoll mascot mark, minimal cut: white head with plain circle ears, three
 * signature spots and flat amber eyes on a theme-primary squircle with a
 * subtle vertical shade + glow. Geometry is shared with public/icon.svg;
 * spot punches use the primary token so they read as cut-outs against the
 * white fur in every theme.
 */
export const AppLogo: React.FC<AppLogoProps> = ({ className }) => (
  <svg
    viewBox="0 0 1024 1024"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    <defs>
      <linearGradient id="quolldesk-logo-shade" x1="512" y1="0" x2="512" y2="1024" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#000000" stopOpacity={0} />
        <stop offset="1" stopColor="#000000" stopOpacity={0.4} />
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="1024" height="1024" rx="192" ry="192" fill="hsl(var(--primary))" />
    <rect x="0" y="0" width="1024" height="1024" rx="192" ry="192" fill="url(#quolldesk-logo-shade)" />
    <circle cx="512" cy="480" r="340" fill="#FFFFFF" fillOpacity={0.08} />
    <circle cx="398" cy="272" r="82" fill="#FFFFFF" />
    <circle cx="626" cy="272" r="82" fill="#FFFFFF" />
    <path d="M 268 470 C 268 360 360 300 512 300 C 664 300 756 360 756 470 C 756 540 730 590 690 630 C 652 668 606 696 566 710 C 546 716 528 720 518 726 C 516 728 514 730 512 734 C 510 730 508 728 506 726 C 496 720 478 716 458 710 C 418 696 372 668 334 630 C 294 590 268 540 268 470 Z" fill="#FFFFFF" />
    <circle cx="512" cy="392" r="20" fill="hsl(var(--primary))" />
    <circle cx="398" cy="510" r="16" fill="hsl(var(--primary))" />
    <circle cx="626" cy="510" r="16" fill="hsl(var(--primary))" />
    <circle cx="430" cy="488" r="40" fill="#F2A93B" />
    <circle cx="594" cy="488" r="40" fill="#F2A93B" />
    <path d="M 492 640 C 492 628 502 622 512 622 C 522 622 532 628 532 640 C 532 660 520 674 512 682 C 504 674 492 660 492 640 Z" fill="#E3867D" />
  </svg>
);

export default AppLogo;
