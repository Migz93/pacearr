import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { getPlexImageSrc } from "../lib/plexImage";

export function Avatar({ avatarUrl, displayName, size = 36, muted = false }: {
  avatarUrl: string | null;
  displayName: string;
  size?: number;
  muted?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const src = getPlexImageSrc(avatarUrl);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const className = `shrink-0 rounded-full object-cover ${muted ? "grayscale opacity-50" : ""}`;
  const style = { width: size, height: size };

  if (src && !failed) {
    return <img className={className} style={style} src={src} alt={displayName} onError={() => setFailed(true)} />;
  }

  return (
    <div className={`${className} grid place-items-center bg-background-container-high text-on-surface-variant`} style={style}>
      {displayName.trim() ? displayName.trim().charAt(0).toUpperCase() : <UserRound size={Math.round(size * 0.66)} />}
    </div>
  );
}
