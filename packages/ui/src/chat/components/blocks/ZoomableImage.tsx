/**
 * An inline picture that opens full size on a click, the way the desktop
 * app's `ZoomableImage` does: the thumbnail is a button, the zoomed picture a
 * modal dialog over the page that Escape, a click on the backdrop or the close
 * button dismisses. The source is the caller's, already checked by
 * `safeImageSrc`; this only draws it twice.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "../../../components/Dialog.tsx";

export function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <button
        type="button"
        className="ch-zoom"
        aria-label={alt ? `Zoom ${alt}` : "Zoom image"}
        onClick={() => setOpen(true)}
      >
        <img className="ch-shot" src={src} alt={alt} />
      </button>
      {open
        ? createPortal(
            <Dialog
              className="ch-zoom-dialog"
              label={alt || "Image"}
              modal
              onDismiss={close}
              backdrop={{ className: "ch-zoom-backdrop", onClose: close }}
            >
              <img className="ch-zoom-full" src={src} alt={alt} />
              <button type="button" className="ch-zoom-close" onClick={close} data-autofocus>
                Close
              </button>
            </Dialog>,
            document.body,
          )
        : null}
    </>
  );
}
