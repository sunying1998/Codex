import { Suspense } from "react";
import Studio from "@/components/studio";
export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="boot-screen">
          <span className="spinner" />
          正在打开映刻…
        </div>
      }
    >
      <Studio />
    </Suspense>
  );
}
