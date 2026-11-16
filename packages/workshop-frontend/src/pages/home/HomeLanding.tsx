import type { ReactNode } from "react";
import { Button, LayerCard } from "@cloudflare/kumo";
import { Sparkle } from "@phosphor-icons/react";
import { useDistrictSidebar } from "../../features/district-frame/districtFrame";
import { UpdateAvailableNotice } from "../../features/deployment-updates/UpdateAvailableNotice";
import HomeTaskSuggestions from "./HomeTaskSuggestions";
import MeshBackground from "./MeshBackground";
import { SchoolHomeIntro } from "./SchoolHomeIntro";
import { SchoolTaskSuggestions } from "./SchoolTaskSuggestions";

export const HomeLanding = ({ composer, onPick, onTeacherOnboarding }: {
  composer: ReactNode;
  onPick: (text: string) => void;
  onTeacherOnboarding: () => void;
}) => {
  const district = useDistrictSidebar();
  return (
    <div className={`relative isolate flex min-h-full w-full flex-col items-center px-4 pb-12 sm:px-8 ${district ? "pt-8 sm:pt-12" : "pt-10 sm:pt-16 lg:pt-24"}`}>
      <UpdateAvailableNotice />
      {!district && <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[460px] overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 95%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 95%)",
        }}
      >
        <MeshBackground />
      </div>}
      <div className={`flex w-full flex-col items-stretch gap-8 ${district ? "max-w-3xl" : "max-w-2xl"}`}>
        {district ? <SchoolHomeIntro /> : <header className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight leading-tight text-kumo-default sm:text-4xl">
            What are we working on?
          </h1>
          <p className="mx-auto mt-3 max-w-md text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
            Ask a question, create an output, or create an app that works with your tools and data.
          </p>
        </header>}

        {district ? (
          <LayerCard className="overflow-visible rounded-2xl">
            <LayerCard.Secondary className="justify-between px-5 py-4">
              <h2 className="text-sm font-medium text-kumo-default">Start a conversation</h2>
              <Sparkle size={18} className="text-kumo-brand" aria-hidden="true" />
            </LayerCard.Secondary>
            <LayerCard.Primary className="gap-0 overflow-visible p-0 pr-0">{composer}</LayerCard.Primary>
          </LayerCard>
        ) : composer}

        {(!district || district.principal?.role === "teacher") && (
          <section aria-labelledby="teacher-onboarding-heading" className="flex flex-col items-start gap-3 rounded-xl border border-kumo-line bg-kumo-base p-4">
            <h2 id="teacher-onboarding-heading" className="font-medium text-kumo-default">Bring your classroom into EducateOS</h2>
            <p className="text-sm text-kumo-subtle">Start with a lesson plan, worksheet or tool you already use. Prepare a personal classroom brief and explore how much you want to integrate.</p>
            <Button onClick={onTeacherOnboarding}>Start with my materials</Button>
          </section>
        )}
        {district ? (
          <SchoolTaskSuggestions onPick={onPick} />
        ) : (
          <HomeTaskSuggestions onPick={onPick} />
        )}
      </div>
    </div>
  );
};
