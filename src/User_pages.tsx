﻿import React, { useEffect, useState } from "react";
import "./App.css";
import "./styles/others-ll.css";
import "./styles/codeblock.css";
import User_pages_win from "./User_pages_win";
import User_pages_linux from "./User_pages_linux";

type OsKey = "windows" | "linux" | "mac";

const TABS: { key: OsKey; label: string }[] = [
  { key: "windows", label: "Windows" },
  { key: "linux", label: "Linux" },
  { key: "mac", label: "macOS" },
];

const User_pages: React.FC = () => {
  const [os, setOs] = useState<OsKey>(() => {
    const saved = localStorage.getItem("user_pages_os") as OsKey | null;
    return saved ?? "windows";
  });

  useEffect(() => {
    localStorage.setItem("user_pages_os", os);
  }, [os]);

  return (
    <div className="others-ll">
      <div role="tablist" aria-label="OS választó" className="others-ll__tabs">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            role="tab"
            aria-selected={os === key}
            aria-controls={`panel-${key}`}
            id={`tab-${key}`}
            className={`others-ll__tab ${os === key ? "is-active" : ""}`}
            onClick={() => setOs(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id="panel-windows"
        aria-labelledby="tab-windows"
        hidden={os !== "windows"}
      >
        <User_pages_win />
      </div>

      <div
        role="tabpanel"
        id="panel-linux"
        aria-labelledby="tab-linux"
        hidden={os !== "linux"}
      >
        <User_pages_linux />
      </div>

      <div
        role="tabpanel"
        id="panel-mac"
        aria-labelledby="tab-mac"
        hidden={os !== "mac"}
      >
        <div className="others-ll__mac-joke">
          <h2>🍎 macOS</h2>
          <p>
            Sorry, we can’t provide programs to Mac users.
          </p>
          <p>
            Try again after you <code> install a real-os</code> 😎
          </p>
          <p style={{ fontStyle: "italic", color: "#888" }}>
            (Just kidding. Kind of.)
          </p>
        </div>
      </div>
    </div>
  );
};

export default User_pages;
