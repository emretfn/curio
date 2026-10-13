import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function PairPage() {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>Pair the extension</CardTitle>
          <CardDescription>
            The pairing token is not shown here: anything on this computer can
            open this page. It is printed in the terminal instead.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="flex list-decimal flex-col gap-2 pl-5">
            <li>
              In a terminal, in the Curio folder, run <code>pnpm pair</code>.
            </li>
            <li>Copy the token it prints.</li>
            <li>
              In Chrome, open the Curio capture popup, paste the token and press
              Pair.
            </li>
          </ol>
        </CardContent>
        <CardFooter>
          <Link href="/status" className="underline underline-offset-3">
            Back to status
          </Link>
        </CardFooter>
      </Card>
    </main>
  );
}
