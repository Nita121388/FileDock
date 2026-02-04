import React from "react";

type Props = {
  children: React.ReactNode;
};

type State = {
  error: Error | null;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("FileDock UI crashed:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="boot-error">
          <div className="boot-error-title">FileDock failed to start</div>
          <div className="boot-error-desc">如果是浏览器预览，请用 Chrome/Edge 打开。</div>
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
