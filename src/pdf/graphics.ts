/**
 * 2D affine transforms, in the layout PDF uses.
 *
 * A transform is six numbers `[a b c d e f]`, which map a point as
 * `x' = a*x + c*y + e` and `y' = b*x + d*y + f`. The `cm` operator post-
 * multiplies: a new transform is applied *before* the one already in place.
 */

export class Matrix {
  constructor(
    readonly a = 1,
    readonly b = 0,
    readonly c = 0,
    readonly d = 1,
    readonly e = 0,
    readonly f = 0,
  ) {}

  static readonly identity = new Matrix();

  static translation(tx: number, ty: number): Matrix {
    return new Matrix(1, 0, 0, 1, tx, ty);
  }

  static scaling(sx: number, sy: number): Matrix {
    return new Matrix(sx, 0, 0, sy, 0, 0);
  }

  static rotation(degrees: number): Matrix {
    const r = (degrees * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return new Matrix(cos, sin, -sin, cos, 0, 0);
  }

  /**
   * The PDF matrix product `m1 x m2`, which is what `cm`, `Tm` and `Td` use.
   *
   * Order matters and is easy to get wrong: `m1` is applied to a point FIRST,
   * then `m2`. So a transform read from the file is always the FIRST argument,
   * as in `Matrix.concat(newTransform, currentCTM)`.
   */
  static concat(m1: Matrix, m2: Matrix): Matrix {
    return new Matrix(
      m1.a * m2.a + m1.b * m2.c,
      m1.a * m2.b + m1.b * m2.d,
      m1.c * m2.a + m1.d * m2.c,
      m1.c * m2.b + m1.d * m2.d,
      m1.e * m2.a + m1.f * m2.c + m2.e,
      m1.e * m2.b + m1.f * m2.d + m2.f,
    );
  }

  apply(x: number, y: number): { x: number; y: number } {
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f };
  }

  /** The determinant. Zero means the transform collapses the plane. */
  determinant(): number {
    return this.a * this.d - this.b * this.c;
  }

  /** The uniform scale factor, which is what a font size has to be scaled by. */
  scaleFactor(): number {
    const det = Math.abs(this.determinant());
    return Math.sqrt(det);
  }

  inverse(): Matrix | null {
    const det = this.determinant();
    if (det === 0) return null;
    const ia = this.d / det;
    const ib = -this.b / det;
    const ic = -this.c / det;
    const id = this.a / det;
    return new Matrix(
      ia,
      ib,
      ic,
      id,
      -(ia * this.e + ic * this.f),
      -(ib * this.e + id * this.f),
    );
  }

  toArray(): [number, number, number, number, number, number] {
    return [this.a, this.b, this.c, this.d, this.e, this.f];
  }

  toString(): string {
    return `[${this.toArray().map((n) => round(n)).join(" ")}]`;
  }
}

function round(n: number): number {
  return Number.isInteger(n) ? n : Number(n.toFixed(4));
}
