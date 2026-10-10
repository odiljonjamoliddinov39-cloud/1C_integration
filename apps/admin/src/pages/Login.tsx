import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Button, Card, ErrorText, Input } from "@/components/ui";
import { api, setToken } from "@/lib/api";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: (session) => setToken(session.accessToken),
  });
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold">AI Accounting Assistant Admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">For our staff only.</p>
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate();
          }}
        >
          <Input
            className="w-full"
            type="email"
            autoComplete="username"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Input
            className="w-full"
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <ErrorText error={login.error} />
          <Button className="w-full" disabled={login.isPending}>
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
