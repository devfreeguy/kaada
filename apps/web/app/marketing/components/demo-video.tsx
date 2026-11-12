import { DEMO_VIDEO_ID, DEMO_VIDEO_URL } from "../../lib/site";

export function DemoVideo() {
  return (
    <div className="mt-8 sm:mt-12">
      <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-border bg-navy">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${DEMO_VIDEO_ID}?rel=0`}
          title="Kaada demo video"
          loading="lazy"
          allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="absolute inset-0 h-full w-full"
        />
      </div>
      <p className="mt-3 text-center text-sm">
        <a href={DEMO_VIDEO_URL} target="_blank" rel="noopener noreferrer" className="underline">
          Watch the demo on YouTube
        </a>
      </p>
    </div>
  );
}
