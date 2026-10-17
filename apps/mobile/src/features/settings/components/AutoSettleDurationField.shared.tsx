import {
  AUTO_SETTLE_DURATION_UNITS,
  autoSettleDurationAmount,
  autoSettleDurationToDays,
  preferredAutoSettleDurationUnit,
  type AutoSettleDurationUnit,
} from "@t3tools/client-runtime/auto-settle-duration";
import { useState } from "react";
import { View } from "react-native";

import { AppTextInput } from "../../../components/ui/AppText";
import { SegmentedControl } from "../../../components/ui/SegmentedControl";

export interface AutoSettleDaysFieldProps {
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  readonly disabled?: boolean;
}

const unitOptions = AUTO_SETTLE_DURATION_UNITS.map((unit) => ({
  value: unit,
  label: { minutes: "Min", hours: "Hours", days: "Days" }[unit],
  accessibilityLabel: { minutes: "Minutes", hours: "Hours", days: "Days" }[unit],
}));

export function AutoSettleDaysField(props: AutoSettleDaysFieldProps) {
  const [unit, setUnit] = useState<AutoSettleDurationUnit>(() =>
    preferredAutoSettleDurationUnit(props.value),
  );
  const [draft, setDraft] = useState<string | null>(null);
  const displayValue = draft ?? autoSettleDurationAmount(props.value, unit);

  const commit = (amount: string, nextUnit: AutoSettleDurationUnit) => {
    if (props.disabled) return;
    const days = autoSettleDurationToDays(Number(amount.trim()), nextUnit);
    if (days !== null && days !== props.value) props.onValueChange(days);
  };

  return (
    <View className="w-full gap-2">
      <AppTextInput
        className="min-h-10 rounded-xl px-3 py-2 text-center text-base"
        keyboardType="decimal-pad"
        returnKeyType="done"
        value={displayValue}
        onChangeText={setDraft}
        onBlur={() => {
          commit(displayValue, unit);
          setDraft(null);
        }}
        onSubmitEditing={() => {
          commit(displayValue, unit);
          setDraft(null);
        }}
        accessibilityLabel="Inactivity before auto-settle"
        editable={!props.disabled}
      />
      <SegmentedControl
        className="w-full"
        size="compact"
        options={unitOptions}
        selected={unit}
        onSelect={(nextUnit) => {
          if (props.disabled) return;
          setUnit(nextUnit);
          commit(displayValue, nextUnit);
          setDraft(null);
        }}
      />
    </View>
  );
}
