/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {backend_util, BackendTimingInfo, buffer, DataStorage, DataType, DataValues, engine, env, kernel_impls, KernelBackend, Rank, ShapeMap, Tensor, Tensor2D, TensorBuffer, TensorInfo, TypedArray, util} from '@tensorflow/tfjs-core';

const whereImpl = kernel_impls.whereImpl;
import {assertNotComplex} from './cpu_util';

interface DataId {}

export interface TensorData<D extends DataType> {
  values?: backend_util.BackendValues;
  dtype: D;
  // For complex numbers, the real and imaginary parts are stored as their own
  // individual tensors, with a parent joining the two with the
  // complexTensorInfos field.
  complexTensorInfos?: {real: TensorInfo, imag: TensorInfo};
  // refCount keeps track of how many tensors reference it. Used for memory
  // management.
  refCount: number;
}

export class MathBackendCPU extends KernelBackend {
  public blockSize = 48;

  data: DataStorage<TensorData<DataType>>;
  private firstUse = true;
  private static nextDataId = 0;
  private nextDataId(): number {
    return MathBackendCPU.nextDataId++;
  }

  constructor() {
    super();
    this.data = new DataStorage(this, engine());
  }

  write(values: backend_util.BackendValues, shape: number[], dtype: DataType):
      DataId {
    if (this.firstUse) {
      this.firstUse = false;
      if (env().get('IS_NODE')) {
        backend_util.warn(
            '\n============================\n' +
            'Hi,looks like you are running TensorFlow.js in ' +
            'Node.js. To speed things up dramatically, install our node ' +
            'backend. Visit https://github.com/tensorflow/tfjs-node for more details. ' +
            '\n============================');
      }
    }
    const dataId = {id: this.nextDataId()};

    this.data.set(dataId, {values, dtype, refCount: 1});

    return dataId;
  }

  /**
   * Create a data bucket in cpu backend.
   * @param shape Shape of the `TensorInfo`.
   * @param dtype DType of the `TensorInfo`.
   * @param values The value of the `TensorInfo` stored as a flattened array.
   */
  makeTensorInfo(
      shape: number[], dtype: DataType,
      values?: backend_util.BackendValues|string[]): TensorInfo {
    let outId;
    if (dtype === 'string' && values != null && values.length > 0 &&
        util.isString(values[0])) {
      const encodedValues =
          (values as {} as string[]).map(d => util.encodeString(d));

      outId = this.write(encodedValues, shape, dtype);
    } else {
      outId = this.write(values as TypedArray, shape, dtype);
    }

    return {dataId: outId, shape, dtype};
  }

  /** Return refCount of a `TensorData`. */
  refCount(dataId: DataId): number {
    if (this.data.has(dataId)) {
      const tensorData = this.data.get(dataId);
      return tensorData.refCount;
    }
    return 0;
  }

  /** Increase refCount of a `TensorData`. */
  incRef(dataId: DataId): void {
    const tensorData = this.data.get(dataId);
    tensorData.refCount++;
  }

  /** Decrease refCount of a `TensorData`. */
  decRef(dataId: DataId): void {
    if (this.data.has(dataId)) {
      const tensorData = this.data.get(dataId);
      tensorData.refCount--;
    }
  }

  move(
      dataId: DataId, values: backend_util.BackendValues, shape: number[],
      dtype: DataType, refCount: number): void {
    this.data.set(dataId, {values, dtype, refCount});
  }

  numDataIds(): number {
    return this.data.numDataIds();
  }

  async read(dataId: DataId): Promise<backend_util.BackendValues> {
    return this.readSync(dataId);
  }
  readSync(dataId: DataId): backend_util.BackendValues {
    const {dtype, complexTensorInfos} = this.data.get(dataId);

    if (dtype === 'complex64') {
      const realValues =
          this.readSync(complexTensorInfos.real.dataId) as Float32Array;
      const imagValues =
          this.readSync(complexTensorInfos.imag.dataId) as Float32Array;
      return backend_util.mergeRealAndImagArrays(realValues, imagValues);
    }

    return this.data.get(dataId).values;
  }

  bufferSync<R extends Rank>(t: TensorInfo): TensorBuffer<R> {
    const data = this.readSync(t.dataId);
    let decodedData = data as DataValues;
    if (t.dtype === 'string') {
      try {
        // Decode the bytes into string.
        decodedData = (data as Uint8Array[]).map(d => util.decodeString(d));
      } catch {
        throw new Error('Failed to decode encoded string bytes into utf-8');
      }
    }
    return buffer(t.shape as ShapeMap[R], t.dtype, decodedData) as
        TensorBuffer<R>;
  }

  makeOutput<T extends Tensor>(
      values: backend_util.BackendValues, shape: number[], dtype: DataType): T {
    return engine().makeTensorFromTensorInfo(
               this.makeTensorInfo(shape, dtype, values), this) as T;
  }

  /**
   * Dispose the memory if the dataId has 0 refCount. Return true if the memory
   * is released or memory is not managed in this backend, false if memory is
   * not cleared.
   * @param dataId
   * @oaram force Optional, remove the data regardless of refCount
   */
  disposeData(dataId: DataId, force = false): boolean {
    if (this.data.has(dataId)) {
      this.data.get(dataId).refCount--;
      if (!force && this.data.get(dataId).refCount > 0) {
        return false;
      }

      const {complexTensorInfos} = this.data.get(dataId);

      if (complexTensorInfos != null) {
        this.disposeData(complexTensorInfos.real.dataId, true);
        this.disposeData(complexTensorInfos.imag.dataId, true);
      }

      this.data.delete(dataId);
    }
    return true;
  }

  disposeIntermediateTensorInfo(tensorInfo: TensorInfo): void {
    this.disposeData(tensorInfo.dataId);
  }

  async time(f: () => void): Promise<BackendTimingInfo> {
    const start = util.now();
    f();
    const kernelMs = util.now() - start;
    return {kernelMs};
  }

  memory() {
    return {
      // Unreliable due to automatic gc. The numbers above are cumulative.
      unreliable: true,
      reasons:
          ['The reported memory is an upper bound. Due to automatic garbage ' +
           'collection, the true allocated memory may be less.']
    };
  }

  where(condition: Tensor): Tensor2D {
    assertNotComplex([condition], 'where');

    const condVals = this.readSync(condition.dataId) as TypedArray;
    return whereImpl(condition.shape, condVals);
  }

  dispose() {}

  floatPrecision(): 16|32 {
    return 32;
  }

  /** Returns the smallest representable number.  */
  epsilon(): number {
    return super.epsilon();
  }
}
