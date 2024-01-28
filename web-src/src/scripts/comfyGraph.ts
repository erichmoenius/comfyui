import { LGraph } from 'litegraph.js';
import { ComfyNode } from './comfyNode';
import { WorkflowStep } from '../../autogen_web_ts/comfy_request.v1';
import { SerializedGraph } from '../types/litegraph';

export class ComfyGraph extends LGraph {
    // Flag that the graph is configuring to prevent nodes from running checks while its still loading
    configuringGraph = false;

    // Overwrite _nodes as ComfyNode[] rather than LGraphNode[]
    get nodes(): ComfyNode[] {
        return super.nodes as ComfyNode[];
    }

    /** optionally pass in a former graph-state to have it restored */
    constructor(serializedGraph?: SerializedGraph) {
        super(serializedGraph);
    }

    // TO DO: I don't like this `configure` or `onConfigure` pattern; seeems really newbish
    // But I'm keeping it for now, because that's how ComfyUI did it
    configure(data: object, keep_old?: boolean): boolean | undefined {
        this.configuringGraph = true;
        try {
            return super.configure(data, keep_old);
        } finally {
            this.configuringGraph = false;
        }
    }

    onConfigure(data: object): void {
        // Fire callbacks before the onConfigure, this is used by widget inputs to setup the config
        for (const node of this.nodes) {
            node.onGraphConfigured?.();
        }

        const r = super.onConfigure ? super.onConfigure(data) : undefined;

        // Fire after onConfigure, used by primitves to generate widget using input nodes config
        for (const node of this.nodes) {
            node.onAfterGraphConfigured?.();
        }

        // Why does ComfyUI return anything here? This is always void from what I can tell
        return r;
    }

    // ===== Override LGraph methods, repalcing LGraphNode with ComfyNode =====

    add(node: ComfyNode, skip_compute_order?: boolean): void {
        super.add(node, skip_compute_order);
    }

    onNodeAdded(node: ComfyNode): void {
        super.onNodeAdded(node);
    }

    remove(node: ComfyNode): void {
        super.remove(node);
    }

    getNodeById(id: number): ComfyNode | undefined {
        return super.getNodeById(id) as ComfyNode; // Cast the result to ComfyNode
    }

    getAncestors(node: ComfyNode): ComfyNode[] {
        return super.getAncestors(node) as ComfyNode[]; // Cast the result to ComfyNode[]
    }

    // findNodesByClass<T extends LGraphNode>(
    //   classObject: LGraphNodeConstructor<T>
    // ): T[] {
    //   return super.findNodesByClass(classObject) as T[]; // Cast the result to an array of ComfyNode
    // }

    // findNodesByType<T extends ComfyNode = ComfyNode>(type: string): T[] {
    //   return super.findNodesByType(type) as T[]; // Cast the result to an array of ComfyNode
    // }

    // findNodeByTitle<T extends ComfyNode = ComfyNode>(title: string): T | null {
    //   return super.findNodeByTitle(title) as T; // Cast the result to ComfyNode
    // }

    // findNodesByTitle<T extends ComfyNode = ComfyNode>(title: string): T[] {
    //   return super.findNodesByTitle(title) as T[]; // Cast the result to an array of ComfyNode
    // }

    // getNodeOnPos<T extends ComfyNode = ComfyNode>(
    //   x: number,
    //   y: number,
    //   node_list?: ComfyNode[],
    //   margin?: number
    // ): T | null {
    //   return super.getNodeOnPos(x, y, node_list, margin) as T; // Cast the result to ComfyNode
    // }

    beforeChange(info?: ComfyNode): void {
        super.beforeChange(info);
    }

    afterChange(info?: ComfyNode): void {
        super.afterChange(info);
    }

    connectionChange(node: ComfyNode): void {
        super.connectionChange(node);
    }

    /** Converts the current graph serializedGraph for sending to the API */
    async graphToWorkflow() {
        for (const outerNode of this.computeExecutionOrder<ComfyNode[]>(false, false)) {
            if (outerNode.widgets) {
                for (const widget of outerNode.widgets) {
                    // Allow widgets to run callbacks before a prompt has been queued
                    // e.g. random seed before every gen
                    widget.beforeQueued?.();
                }
            }

            const innerNodes = outerNode.getInnerNodes ? outerNode.getInnerNodes() : [outerNode];
            for (const node of innerNodes) {
                if (node.isVirtualNode) {
                    // Don't serialize frontend only nodes but let them make changes
                    if (node.applyToGraph) {
                        node.applyToGraph();
                    }
                }
            }
        }

        // serializedGraph is used for storing and reloading the full state of the graph
        // apiWorkflow is sent to the API for inference
        const serializedGraph = this.serialize();
        const apiWorkflow: Record<string, WorkflowStep> = {};

        // Process nodes in order of execution
        for (const outerNode of this.computeExecutionOrder(false, false)) {
            const skipNode = outerNode.mode === 2 || outerNode.mode === 4;
            const innerNodes = !skipNode && outerNode.getInnerNodes ? outerNode.getInnerNodes() : [outerNode];
            for (const node of innerNodes) {
                if (node.isVirtualNode) {
                    continue;
                }

                if (node.mode === 2 || node.mode === 4) {
                    // Don't serialize muted nodes
                    continue;
                }

                const inputs: Record<string, any> = {};
                const widgets = node.widgets;

                // Store all widget values
                if (widgets) {
                    for (const i in widgets) {
                        const widget = widgets[i];
                        if (!widget.options || widget.options.serialize !== false) {
                            inputs[widget.name] = widget.serializeValue
                                ? await widget.serializeValue(node, i)
                                : widget.value;
                        }
                    }
                }

                // Store all node links
                for (let i in node.inputs) {
                    let parent = node.getInputNode(i);
                    if (parent) {
                        let link = node.getInputLink(i);
                        while (parent.mode === 4 || parent.isVirtualNode) {
                            let found = false;
                            if (parent.isVirtualNode) {
                                link = parent.getInputLink(link.origin_slot);
                                if (link) {
                                    parent = parent.getInputNode(link.target_slot);
                                    if (parent) {
                                        found = true;
                                    }
                                }
                            } else if (link && parent.mode === 4) {
                                let all_inputs = [link.origin_slot];
                                if (parent.inputs) {
                                    all_inputs = all_inputs.concat(Object.keys(parent.inputs));
                                    for (let parent_input in all_inputs) {
                                        parent_input = all_inputs[parent_input];
                                        if (parent.inputs[parent_input]?.type === node.inputs[i].type) {
                                            link = parent.getInputLink(parent_input);
                                            if (link) {
                                                parent = parent.getInputNode(parent_input);
                                            }
                                            found = true;
                                            break;
                                        }
                                    }
                                }
                            }

                            if (!found) {
                                break;
                            }
                        }

                        if (link) {
                            if (parent?.updateLink) {
                                link = parent.updateLink(link);
                            }
                            if (link) {
                                inputs[node.inputs[i].name] = [String(link.origin_id), parseInt(link.origin_slot)];
                            }
                        }
                    }
                }

                let node_data: WorkflowStep = {
                    class_type: node.comfyClass,
                    inputs,
                };

                apiWorkflow[String(node.id)] = node_data;
            }
        }

        // Remove inputs connected to removed nodes
        for (const o in apiWorkflow) {
            for (const i in apiWorkflow[o].inputs) {
                if (
                    Array.isArray(apiWorkflow[o].inputs![i]) &&
                    apiWorkflow[o].inputs![i].length === 2 &&
                    !apiWorkflow[apiWorkflow[o].inputs![i][0]]
                ) {
                    delete apiWorkflow[o].inputs![i];
                }
            }
        }

        return { serializedGraph, apiWorkflow };
    }
}
