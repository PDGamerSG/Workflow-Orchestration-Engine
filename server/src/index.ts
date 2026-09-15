import express from "express";
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
    apiKey: process.env.GOOGLE_API_KEY
});

const StepGraph = z.array(z.object({
    id: z.string(),
    prompt: z.string(),
    dependsOn: z.array(z.string()).optional()
}))

type StepGraph = z.infer<typeof StepGraph>

const CreateWorkflowSchema = z.object({
    workflowId: z.string(),
    steps: StepGraph
})

const CreateWorkflowResponse = z.object({
    results: z.array(z.object({
        id: z.string(),
        result: z.string()
    }))
})

const app = express();
app.use(express.json())

app.post("/workflow", async (req, res) => {
    const workflow = req.body.workflow;
    const { success, data, error } = CreateWorkflowSchema.safeParse(workflow);

    if (!success) {
        res.status(411).json({
            message: "incorrect inputs"
        })
        return;
    }
    const result = await resolveGraph(data.steps);

    res.json({
        result
    })
})

function resolveGraph(graph: StepGraph): Promise<{result: string, id: string}[]>  {
    return new Promise(async (resolve) => {
        if (!graph.length) {
            resolve([])
            return
        }
        const canResolveNowNodes = graph.filter(x => !x.dependsOn || x.dependsOn.length == 0); // [{"id": "A", "command": "sleep 2"}]
        const promises = canResolveNowNodes.map(node => runAgent(node.prompt))
        const results = await Promise.all(promises);
        graph = graph.map(g => {
            if (g.dependsOn) {
                return {
                    ...g,
                    dependsOn: g.dependsOn.filter(id => !canResolveNowNodes.map(x => x.id).includes(id))
                }
            } else {
                return g
            }
        }).filter(node => !canResolveNowNodes.map(x => x.id).includes(node.id))

        resolve([...results.map((r, index) => ({
            result: r.result!,
            id: canResolveNowNodes[index]?.id!
        })), ...await resolveGraph(graph)])
    })
}

function runAgent(prompt: string): Promise<{result: string}> {
    console.log("ran prompt " + prompt);
    return new Promise(async (resolve) => {
        const response = await ai.models.generateContent({
            model: "gemini-3.5-flash",
            contents: prompt,
          });
          resolve({result: response.text!});
    })
}

app.listen(4000);
