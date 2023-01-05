/// <reference types="@webgpu/types" />
import { Vector3 } from './Vector3'
import type { Camera } from './Camera'
import { Mesh, type Mode } from './Mesh'
import type { Object3D } from './Object3D'
import { type RenderTarget } from './RenderTarget'
import { Compiled } from './_utils'
import type { Attribute, AttributeData, Geometry } from './Geometry'
import type { Material, Side, Uniform } from './Material'
import { Texture, type TextureWrapping } from './Texture'

const GPU_CULL_SIDES: Record<Side, string> = {
  front: 'back',
  back: 'front',
  both: 'none',
} as const

const GPU_DRAW_MODES: Record<Mode, string> = {
  points: 'point-list',
  lines: 'line-list',
  triangles: 'triangle-list',
} as const

const GPU_TEXTURE_WRAPPINGS: Record<TextureWrapping, string> = {
  clamp: 'clamp-to-edge',
  repeat: 'repeat',
  mirror: 'mirror-repeat',
}

// Pad to 16 byte chunks of 2, 4 (std140 layout)
const pad2 = (n: number) => n + (n % 2)
const pad4 = (n: number) => n + ((4 - (n % 4)) % 4)

/**
 * Packs uniforms into a std140 compliant array buffer.
 */
function std140(uniforms: Uniform[], buffer?: Float32Array): Float32Array {
  const values = uniforms as Exclude<Uniform, Texture>[]

  // Init buffer
  if (!buffer) {
    const length = pad4(
      values.reduce(
        (n: number, u) => n + (typeof u === 'number' ? 1 : u.length <= 2 ? pad2(u.length) : pad4(u.length)),
        0,
      ),
    )
    buffer = new Float32Array(length)
  }

  // Pack buffer
  let offset = 0
  for (const value of values) {
    if (typeof value === 'number') {
      buffer[offset] = value
      offset += 1 // leave empty space to stack primitives
    } else {
      const pad = value.length <= 2 ? pad2 : pad4
      offset = pad(offset) // fill in empty space
      buffer.set(value, offset)
      offset += pad(value.length)
    }
  }

  return buffer
}

/**
 * Returns a list of used uniforms from shader uniform structs.
 */
function parseUniforms(...shaders: string[]): string[] | undefined {
  // Filter to most complete definition
  if (shaders.length > 1) {
    const definitions = shaders.map((shader) => parseUniforms(shader))
    return definitions.filter(Boolean).sort((a: any, b: any) => b.length - a.length)[0]
  }

  // Remove comments for parsing
  const shader = shaders[0].replace(/\/\*(?:[^*]|\**[^*/])*\*+\/|\/\/.*/g, '')

  // Bail if no uniforms defined
  if (!shader.includes('uniform ') && !shader.includes('var<uniform>')) return

  // Detect and parse shader layout
  const selector = shader.match(/var<uniform>[^;]+(?:\s|:)(\w+);/)?.[1] ?? 'uniform '
  const layout = shader.match(new RegExp(`${selector}[^\\{]+\\{([^\\}]+)\\}`))?.[1]
  if (!layout) return

  // Parse definitions
  const names = Array.from(layout.match(/\w+(?=[;:])/g)!)

  return names
}

/**
 * {@link WebGPURenderer} constructor parameters.
 */
export interface WebGPURendererOptions {
  /**
   * An optional canvas element to draw to.
   */
  canvas: HTMLCanvasElement
  /**
   * An optional WebGPU context to draw with.
   */
  context: GPUCanvasContext
  /**
   * An optional WebGPU device to request from.
   */
  device: GPUDevice
  /**
   * An optional GPUFormat to create texture views with.
   */
  format: GPUTextureFormat
  /**
   * Whether to prioritize rendering performance or power efficiency.
   */
  powerPreference: GPUPowerPreference
  /**
   * Will fail device initialization if a feature is not met.
   */
  requiredFeatures: Iterable<GPUFeatureName>
  /**
   * Will fail device initialization if a limit is not met.
   */
  requiredLimits: Record<string, GPUSize64>
}

/**
 * Constructs a WebGPU renderer object. Can be extended to draw to a canvas.
 */
export class WebGPURenderer {
  /**
   * Output {@link HTMLCanvasElement} to draw to.
   */
  readonly canvas: HTMLCanvasElement
  public device!: GPUDevice
  /**
   * Internal {@link GPUCanvasContext} to draw with.
   */
  public context!: GPUCanvasContext
  public format!: GPUTextureFormat
  /**
   * Whether to clear the drawing buffer between renders. Default is `true`.
   */
  public autoClear = true

  private _params: Partial<Omit<WebGPURendererOptions, 'canvas'>>
  private _buffers = new Compiled<Attribute, GPUBuffer>()
  private _geometry = new Compiled<Geometry, true>()
  private _UBOs = new Compiled<Material, { data: Float32Array; buffer: GPUBuffer }>()
  private _pipelines = new Compiled<Mesh, GPURenderPipeline>()
  private _textures = new Compiled<Texture, GPUTexture>()
  private _samplers = new Compiled<GPUTexture, GPUSampler>()
  private _FBOs = new Compiled<
    RenderTarget,
    { views: GPUTextureView[]; depthTexture: GPUTexture; depthTextureView: GPUTextureView }
  >()
  private _depthTexture!: GPUTexture
  private _depthTextureView!: GPUTextureView
  private _commandEncoder!: GPUCommandEncoder
  private _passEncoder!: GPURenderPassEncoder
  private _renderTarget: RenderTarget | null = null
  private _v = new Vector3()

  constructor({ canvas, context, format, device, ...params }: Partial<WebGPURendererOptions> = {}) {
    this.canvas = canvas ?? document.createElement('canvas')
    this.context = context ?? this.canvas.getContext('webgpu')!
    this.format = format ?? navigator.gpu.getPreferredCanvasFormat()
    this.device = device!
    this._params = params
  }

  /**
   * Sets the canvas size.
   */
  setSize(width: number, height: number): void {
    this.canvas.width = width
    this.canvas.height = height

    // Resize swap chain after init
    if (this.device) {
      this.context.configure({
        device: this.device,
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        alphaMode: 'premultiplied',
      })

      if (this._depthTexture) this._depthTexture.destroy()
      this._depthTexture = this.device.createTexture({
        size: [width, height, 1],
        format: 'depth24plus-stencil8',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
      this._depthTextureView = this._depthTexture.createView()
    }
  }

  /**
   * Sets the current {@link RenderTarget} to render into.
   */
  setRenderTarget(renderTarget: RenderTarget | null): void {
    this._renderTarget = renderTarget
  }

  /**
   * Initializes the internal WebGPU context and swapchain.
   */
  async init(): Promise<this> {
    if (!this.device) {
      const adapter = await navigator.gpu.requestAdapter(this._params)
      this.device = await adapter!.requestDevice(this._params)
    }

    // Resize swapchain
    this.setSize(this.canvas.width, this.canvas.height)

    return this
  }

  private _createBuffer(data: AttributeData, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: data.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    })

    new (data.constructor as Float32ArrayConstructor)(buffer.getMappedRange()).set(data)
    buffer.unmap()

    return buffer
  }

  private _writeBuffer(
    buffer: GPUBuffer,
    data: AttributeData,
    byteLength = data.byteLength,
    srcByteOffset = 0,
    dstByteOffset = data.byteOffset,
  ): void {
    const size = data.BYTES_PER_ELEMENT
    this.device.queue.writeBuffer(buffer, dstByteOffset, data, srcByteOffset / size, byteLength / size)
  }

  /**
   * Updates a texture with an optional `width` and `height`.
   */
  private _updateTexture(
    texture: Texture,
    width = texture.image?.width ?? 0,
    height = texture.image?.height ?? 0,
  ): void {
    let previous = this._textures.get(texture)
    if (!previous || texture.needsUpdate) {
      previous?.destroy()

      const sampler = this.device.createSampler({
        addressModeU: GPU_TEXTURE_WRAPPINGS[texture.wrapS] as GPUAddressMode,
        addressModeV: GPU_TEXTURE_WRAPPINGS[texture.wrapT] as GPUAddressMode,
        magFilter: texture.magFilter as GPUFilterMode,
        minFilter: texture.minFilter as GPUFilterMode,
        maxAnisotropy: texture.anisotropy,
      })

      const target = this.device.createTexture({
        format: this.format,
        dimension: '2d',
        size: [width, height, 1],
        usage:
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC,
      })

      if (texture.image) {
        this.device.queue.copyExternalImageToTexture({ source: texture.image }, { texture: target }, [width, height])
      }

      this._textures.set(texture, target, () => target.destroy())
      this._samplers.set(target, sampler)

      texture.needsUpdate = false
    }
  }

  /**
   * Compiles a mesh or program and sets initial uniforms.
   */
  compile(mesh: Mesh, camera?: Camera): void {
    mesh.material.uniforms.modelMatrix = mesh.matrix

    if (camera) {
      mesh.material.uniforms.projectionMatrix = camera.projectionMatrix
      mesh.material.uniforms.viewMatrix = camera.viewMatrix
      mesh.material.uniforms.normalMatrix = mesh.normalMatrix
      mesh.material.uniforms.modelViewMatrix = mesh.modelViewMatrix

      mesh.modelViewMatrix.copy(camera.viewMatrix).multiply(mesh.matrix)
      mesh.normalMatrix.normal(mesh.modelViewMatrix)
    }

    const buffers: GPUVertexBufferLayout[] = []

    let shaderLocation = 0
    for (const key in mesh.geometry.attributes) {
      const attribute = mesh.geometry.attributes[key]
      if (key === 'index') continue

      buffers.push({
        arrayStride: attribute.size * attribute.data.BYTES_PER_ELEMENT,
        attributes: [
          {
            shaderLocation: shaderLocation++,
            offset: 0,
            format: `float32x${attribute.size}`,
          },
        ] as Iterable<GPUVertexAttribute>,
      })
    }

    const transparent = mesh.material.transparent
    const cullMode = GPU_CULL_SIDES[mesh.material.side] as GPUCullMode
    const topology = GPU_DRAW_MODES[mesh.mode] as GPUPrimitiveTopology
    const depthWriteEnabled = mesh.material.depthWrite
    const depthCompare = (mesh.material.depthTest ? 'less' : 'always') as GPUCompareFunction
    const blending = mesh.material.blending
    const colorAttachments = this._renderTarget?.count ?? 1

    const pipelineCacheKey = JSON.stringify([
      transparent,
      cullMode,
      topology,
      depthWriteEnabled,
      depthCompare,
      buffers,
      blending,
      colorAttachments,
    ])

    let pipeline = this._pipelines.get(mesh)
    if (!pipeline || pipeline.label !== pipelineCacheKey) {
      pipeline = this.device.createRenderPipeline({
        label: pipelineCacheKey,
        vertex: {
          module: this.device.createShaderModule({ code: mesh.material.vertex }),
          entryPoint: 'main',
          buffers,
        },
        fragment: {
          module: this.device.createShaderModule({ code: mesh.material.fragment }),
          entryPoint: 'main',
          targets: Array<GPUColorTargetState>(colorAttachments).fill({
            format: this.format,
            blend: mesh.material.blending,
            writeMask: GPUColorWrite.ALL,
          }),
        },
        primitive: {
          frontFace: 'ccw',
          cullMode,
          topology,
        },
        depthStencil: {
          depthWriteEnabled,
          depthCompare,
          format: 'depth24plus-stencil8',
        },
        layout: 'auto',
      })
      this._pipelines.set(mesh, pipeline)
    }
    this._passEncoder.setPipeline(pipeline)

    let slot = 0
    for (const key in mesh.geometry.attributes) {
      const attribute = mesh.geometry.attributes[key]
      const isIndex = key === 'index'

      let buffer = this._buffers.get(attribute)
      if (!buffer) {
        buffer = this._createBuffer(attribute.data, GPUBufferUsage[isIndex ? 'INDEX' : 'VERTEX'])
        this._buffers.set(attribute, buffer)
        attribute.needsUpdate = false
      }

      if (attribute.needsUpdate) {
        this._writeBuffer(buffer, attribute.data)
        attribute.needsUpdate = false
      }

      if (isIndex) {
        this._passEncoder.setIndexBuffer(buffer, 'uint32')
      } else {
        this._passEncoder.setVertexBuffer(slot++, buffer)
      }
    }

    if (!this._geometry.get(mesh.geometry)) {
      this._geometry.set(mesh.geometry, true, () => {
        for (const key in mesh.geometry.attributes) {
          const attribute = mesh.geometry.attributes[key]
          this._buffers.get(attribute)?.destroy()
          this._buffers.delete(attribute)
          attribute.needsUpdate = true
        }
      })
    }

    let binding = 0
    const entries: GPUBindGroupEntry[] = []

    const parsed = parseUniforms(mesh.material.vertex, mesh.material.fragment)
    if (parsed) {
      const uniforms = parsed.map((key) => mesh.material.uniforms[key])
      let UBO = this._UBOs.get(mesh.material)
      if (!UBO) {
        const data = std140(uniforms)
        const buffer = this._createBuffer(data, GPUBufferUsage.UNIFORM)
        UBO = { data, buffer }
        this._UBOs.set(mesh.material, UBO, () => buffer.destroy())
      } else {
        this._writeBuffer(UBO.buffer, std140(uniforms, UBO.data))
      }

      entries.push({ binding: binding++, resource: UBO })
    }

    for (const key in mesh.material.uniforms) {
      const value = mesh.material.uniforms[key]
      if (value instanceof Texture) {
        this._updateTexture(value)
        const target = this._textures.get(value)!
        const sampler = this._samplers.get(target)!

        entries.push(
          {
            binding: binding++,
            resource: sampler,
          },
          {
            binding: binding++,
            resource: target.createView(),
          },
        )
      }
    }

    if (entries.length) {
      const bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries,
      })
      this._passEncoder.setBindGroup(0, bindGroup)
    }
  }

  /**
   * Returns a list of visible meshes. Will frustum cull and depth-sort with a camera if available.
   */
  sort(scene: Object3D, camera?: Camera): Mesh[] {
    const renderList: Mesh[] = []

    if (camera?.matrixAutoUpdate) {
      camera.projectionViewMatrix.copy(camera.projectionMatrix).multiply(camera.viewMatrix)
      camera.frustum.fromMatrix4(camera.projectionViewMatrix)
      camera.frustum.normalNDC()
    }

    scene.traverse((node) => {
      // Skip invisible nodes
      if (!node.visible) return true

      // Filter to meshes
      if (!(node instanceof Mesh)) return

      // Frustum cull if able
      if (camera && node.frustumCulled) {
        const inFrustum = camera.frustum.contains(node)
        if (!inFrustum) return true
      }

      renderList.push(node)
    })

    return renderList.sort(
      (a, b) =>
        // Push UI to front
        (b.material.depthTest as unknown as number) - (a.material.depthTest as unknown as number) ||
        // Depth sort with a camera if able
        (!!camera &&
          this._v.set(b.matrix[12], b.matrix[13], b.matrix[14]).applyMatrix4(camera.projectionViewMatrix).z -
            this._v.set(a.matrix[12], a.matrix[13], a.matrix[14]).applyMatrix4(camera.projectionViewMatrix).z) ||
        // Reverse painter's sort transparent
        (a.material.transparent as unknown as number) - (b.material.transparent as unknown as number),
    )
  }

  /**
   * Renders a scene of objects with an optional camera.
   */
  render(scene: Object3D, camera?: Camera): void {
    // Compile render target
    let FBO = this._FBOs.get(this._renderTarget!)
    if (this._renderTarget && (!FBO || this._renderTarget.needsUpdate)) {
      FBO?.depthTexture.destroy()

      const views = this._renderTarget.textures.map((texture) => {
        this._updateTexture(texture, this._renderTarget!.width, this._renderTarget!.height)
        const target = this._textures.get(texture)!
        return target.createView()
      })

      const depthTexture = this.device.createTexture({
        size: [this._renderTarget.width, this._renderTarget.height, 1],
        format: 'depth24plus-stencil8',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
      const depthTextureView = depthTexture.createView()

      FBO = { views, depthTexture, depthTextureView }
      this._FBOs.set(this._renderTarget, FBO, () => depthTexture.destroy())
    }

    const renderViews = FBO?.views ?? [this.context.getCurrentTexture().createView()]
    const depthView = FBO?.depthTextureView ?? this._depthTextureView
    const loadOp: GPULoadOp = this.autoClear ? 'clear' : 'load'

    this._commandEncoder = this.device.createCommandEncoder()
    this._passEncoder = this._commandEncoder.beginRenderPass({
      colorAttachments: renderViews.map<GPURenderPassColorAttachment>((view) => ({
        view,
        loadOp,
        storeOp: 'store',
      })),
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1,
        depthLoadOp: loadOp,
        depthStoreOp: 'store',
        stencilClearValue: 0,
        stencilLoadOp: loadOp,
        stencilStoreOp: 'store',
      },
    })

    if (this._renderTarget)
      this._passEncoder.setViewport(0, 0, this._renderTarget.width, this._renderTarget.height, 0, 1)
    else this._passEncoder.setViewport(0, 0, this.canvas.width, this.canvas.height, 0, 1)

    scene.updateMatrix()
    camera?.updateMatrix()
    if (camera?.matrixAutoUpdate) camera.projectionViewMatrix.normalNDC()

    const renderList = this.sort(scene, camera)
    for (const node of renderList) {
      this.compile(node, camera)

      // Alternate drawing for indexed and non-indexed children
      const { index, position } = node.geometry.attributes
      if (index) {
        this._passEncoder.drawIndexed(index.data.length / index.size, node.instances)
      } else {
        this._passEncoder.draw(position.data.length / position.size, node.instances)
      }
    }

    // Cleanup frame, submit GPU commands
    this._passEncoder.end()
    this.device.queue.submit([this._commandEncoder.finish()])
  }
}
