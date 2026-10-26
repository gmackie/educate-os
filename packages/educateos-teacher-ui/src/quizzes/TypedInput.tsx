import { useState, type ComponentProps } from "react";
import { Input, InputArea } from "@cloudflare/kumo";

type InputProps = Omit<ComponentProps<typeof Input>, "value" | "defaultValue" | "onChange">;
type InputAreaProps = Omit<ComponentProps<typeof InputArea>, "value" | "defaultValue" | "onChange" | "onValueChange">;

/**
 * An input that keeps exactly what the teacher typed, such as a half-typed number, while the
 * parent takes each change only once it reads as a value. The text is held here so the field
 * stays controlled: a changing `defaultValue` is a Base UI error, and the parent's value can't be
 * the text because "1." or "" isn't one.
 */
export const TypedInput = ({ initial, onText, ...props }: InputProps & { initial: string; onText: (text: string) => void }) => {
  const [text, setText] = useState(initial);
  return (
    <Input
      {...props}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onText(event.target.value);
      }}
    />
  );
};

/** {@link TypedInput} for several lines. */
export const TypedInputArea = ({ initial, onText, ...props }: InputAreaProps & { initial: string; onText: (text: string) => void }) => {
  const [text, setText] = useState(initial);
  return (
    <InputArea
      {...props}
      value={text}
      onValueChange={(next) => {
        setText(next);
        onText(next);
      }}
    />
  );
};
