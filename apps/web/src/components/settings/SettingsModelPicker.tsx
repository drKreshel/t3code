import type { ComponentProps } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import {
  ComposerEffortColumn,
  describeComposerEffort,
  SpeedControl,
} from "../chat/ComposerModelEffort";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import type { TraitsSelectionInput } from "../chat/TraitsPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settingsLayout";

type SettingsModelPickerProps = Omit<
  ComponentProps<typeof ProviderModelPicker>,
  "effortColumn" | "footer" | "triggerSuffix" | "triggerDetail" | "triggerClassName"
> & {
  /** The model's effort and other options; null when none apply, such as a mixed selection. */
  traits: TraitsSelectionInput | null;
};

/** The composer's model and effort control, styled like the selects beside it in settings. */
export function SettingsModelPicker({ traits, ...props }: SettingsModelPickerProps) {
  const effortDisplay = useClientSettings((settings) => settings.effortDisplay);
  const effort = describeComposerEffort(traits, effortDisplay, props.size ?? "sm");
  return (
    <ProviderModelPicker
      {...props}
      triggerClassName={cn("group/model-trigger", SETTINGS_PICKER_TRIGGER_CLASSNAME)}
      triggerSuffix={effort.suffix}
      triggerDetail={effort.detail}
      {...(traits
        ? {
            effortColumn: <ComposerEffortColumn traits={traits} />,
            footer: (
              <div className="flex items-center gap-2 border-t border-border/70 bg-muted/40 px-3 py-2 empty:hidden">
                <SpeedControl traits={traits} />
              </div>
            ),
          }
        : {})}
    />
  );
}
