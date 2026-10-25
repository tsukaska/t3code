import { BackHandler } from "react-native";

/**
 * Ref callback that handles the Android hardware back button while the element
 * is mounted. Attach it to a view that only renders in the state back should
 * leave (an open search field, an overlay). `onBack` returns false to let the
 * press fall through to the next handler.
 */
export function backHandlerRef(onBack: () => boolean) {
  return (node: object | null) => {
    if (node === null) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", onBack);
    return () => subscription.remove();
  };
}
